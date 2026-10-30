import { expect, test, type Page } from "@playwright/test";
import { ensureOpen } from "./helpers";

/**
 * Everything here sits behind real Supabase auth and needs the migrations applied. Signed-in tests run
 * only when E2E_EMAIL / E2E_PASSWORD point at an existing, confirmed user:
 *
 *   E2E_EMAIL=you@example.com E2E_PASSWORD=... npm run test:e2e
 *
 * Without them those tests are skipped (never faked). The flow test sends a real event through the
 * ingestion API, so NEXT_PUBLIC_SITE_URL must point at the server under test.
 */
const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;

const UUID = "00000000-0000-4000-8000-000000000000";

test.describe("route protection", () => {
  test.beforeEach(async ({ request }) => {
    const health = await (await request.get("/api/health")).json();
    test.skip(!health.supabaseConfigured, "Supabase env is not configured");
  });

  for (const path of ["/dashboard", "/incidents", "/events", `/incidents/${UUID}`, "/incidents/not-a-uuid", "/settings"]) {
    test(`${path} redirects signed-out visitors to /login`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login\?next=/);
      await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    });
  }
});

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email!);
  await page.getByLabel("Password", { exact: true }).fill(password!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/(dashboard|onboarding)/);
}

test.describe("signed-in app (needs E2E_EMAIL / E2E_PASSWORD and applied migrations)", () => {
  test.skip(!email || !password, "E2E_EMAIL / E2E_PASSWORD not set");

  test.describe("desktop 1440px", () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test("the dashboard renders real KPIs and works with direct URLs", async ({ page }) => {
      await signIn(page);
      await page.goto("/dashboard?range=7d");
      await expect(page.getByRole("heading", { name: "Project overview" })).toBeVisible();
      for (const label of ["Total events", "Error rate", "Unresolved incidents", "Affected endpoints"]) {
        await expect(page.getByRole("heading", { name: label, level: 3, exact: true })).toBeVisible();
      }
      await expect(page.getByRole("radio", { name: "Last 7 days" })).toBeChecked();
      await page.screenshot({ path: "test-results/dashboard-1440.png", fullPage: true });
    });

    test("send test event -> incident -> status changes -> events explorer", async ({ page }) => {
      await signIn(page);

      // 1. Send a real event through the ingestion API from the dashboard.
      await page.goto("/dashboard");
      await page.getByRole("button", { name: "Send test event" }).first().click();
      const dialog = page.getByRole("dialog", { name: "Send test event" });
      await dialog.getByRole("button", { name: "Send test event" }).click();
      await expect(dialog.getByRole("status")).toContainText("ingestion API", { timeout: 20_000 });
      await page.keyboard.press("Escape");

      // 2. The incident list shows it, with real counters.
      await page.goto("/incidents");
      await expect(page.getByRole("heading", { name: "Incidents", level: 1 })).toBeVisible();
      await expect(page.getByRole("region", { name: "Incident summary" })).toBeVisible();
      const link = page.getByRole("table").getByRole("link", { name: /checkout total was NaN/ }).first();
      await expect(link).toBeVisible();

      // 3. Filters live in the URL and survive a reload.
      await page.getByLabel("Severity").selectOption("critical");
      await expect(page).toHaveURL(/severity=critical/);
      await expect(page.getByText("No incidents match your filters")).toBeVisible();
      await page.reload();
      await expect(page.getByLabel("Severity")).toHaveValue("critical");
      await page.getByRole("button", { name: "Clear filters" }).click();
      await expect(page).not.toHaveURL(/severity=/);
      await page.getByRole("searchbox").fill("checkout total");
      await expect(page).toHaveURL(/q=checkout/);
      await page.getByRole("button", { name: "Clear search" }).click();
      await expect(page).not.toHaveURL(/q=/);

      // 4. Detail page: status transitions persist.
      await page.getByRole("table").getByRole("link", { name: /checkout total was NaN/ }).first().click();
      await expect(page).toHaveURL(/\/incidents\/[0-9a-f-]{36}/);
      await expect(page.getByRole("heading", { level: 1 })).toContainText("checkout total was NaN");
      await expect(page.getByRole("list", { name: "Incident timeline" })).toBeVisible();

      await ensureOpen(page);
      await page.getByRole("button", { name: "Acknowledge" }).click();
      await expect(page.getByText("Investigating").first()).toBeVisible();
      await page.getByRole("button", { name: "Resolve" }).click();
      await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible();
      await page.reload(); // persisted, not just client state
      await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible();
      await page.getByRole("button", { name: "Reopen" }).click();
      await expect(page.getByRole("button", { name: "Acknowledge" })).toBeVisible();
      await expect(page.getByText("Reopened").or(page.getByText("You changed the status")).first()).toBeVisible();

      // 5. Stack trace expands; AI panel is present with a real control.
      await page.getByRole("button", { name: /Stack trace/ }).first().click();
      await expect(page.getByLabel("Stack trace text").first()).toContainText("calculateTotal");
      await expect(page.getByRole("button", { name: /Investigate with AI|Re-run investigation|Try again/ })).toBeVisible();

      // 6. Events explorer.
      await page.goto("/events");
      await expect(page.getByRole("heading", { name: "Events", level: 1 })).toBeVisible();
      await page.getByRole("list", { name: "Events" }).getByRole("button").first().click();
      await expect(page.getByRole("region", { name: "Event details" })).toContainText("calculateTotal");
      await expect(page.getByRole("button", { name: "Copy ID" })).toBeVisible();
      await page.getByLabel("Level").selectOption("debug");
      await expect(page.getByText("No events match your filters")).toBeVisible();
    });

    test("a malformed or unknown incident id is a 404, not an error page", async ({ page }) => {
      await signIn(page);
      // The route streams behind a loading skeleton, so the status line is already 200; what matters is the user sees "not found", not an error.
      for (const path of ["/incidents/not-a-uuid", `/incidents/${UUID}`]) {
        await page.goto(path);
        await expect(page.getByRole("heading", { name: /not found/i })).toBeVisible();
        await expect(page.getByText(/couldn.t load/i)).toHaveCount(0);
      }
    });

    test("junk query parameters never break a page", async ({ page }) => {
      await signIn(page);
      const res = await page.goto("/incidents?status=bogus&sort=title%3Bdrop&page=-5&project=../../x&since=forever");
      expect(res?.status()).toBe(200);
      await expect(page.getByRole("heading", { name: "Incidents", level: 1 })).toBeVisible();
    });

    test("sidebar collapses and the command palette opens with Ctrl+K", async ({ page }) => {
      await signIn(page);
      await page.goto("/dashboard");
      await page.getByRole("button", { name: "Collapse sidebar" }).click();
      await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
      await page.keyboard.press("Control+k");
      await expect(page.getByRole("dialog", { name: "Search and commands" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toBeHidden();
    });
  });

  test.describe("mobile 390px", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    for (const path of ["/dashboard", "/incidents", "/events"]) {
      test(`${path} has no horizontal overflow`, async ({ page }) => {
        await signIn(page);
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        await page.screenshot({ path: `test-results/signed-in${path.replace("/", "-")}-390.png`, fullPage: true });
      });
    }

    test("the navigation drawer works", async ({ page }) => {
      await signIn(page);
      await page.goto("/dashboard");
      await page.getByRole("button", { name: "Open navigation" }).click();
      const drawer = page.getByRole("dialog");
      await expect(drawer).toBeVisible();
      await drawer.getByRole("link", { name: /Incidents/ }).click();
      await expect(page).toHaveURL(/\/incidents/);
      await expect(drawer).toBeHidden();
    });
  });
});
