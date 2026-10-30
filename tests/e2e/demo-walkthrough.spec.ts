import { expect, test } from "@playwright/test";
import { ensureOpen } from "./helpers";

/**
 * The "Try the demo" walkthrough in a real browser against real Supabase. Needs a confirmed user and the
 * applied migrations (see dashboard.spec.ts). Skipped, never faked, without E2E_EMAIL / E2E_PASSWORD.
 * It creates (idempotently) and finally removes the signed-in user's own simulated demo project, so run it
 * with a throwaway account. Screenshots go to test-results/.
 *
 * Needs no AI key: the demo ships a pre-written, labelled-simulated investigation.
 */
const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;

test.describe("demo walkthrough (needs E2E_EMAIL / E2E_PASSWORD and applied migrations)", () => {
  test.skip(!email || !password, "E2E_EMAIL / E2E_PASSWORD not set");
  test.use({ viewport: { width: 1440, height: 900 } });

  test("dashboard spike -> checkout incident -> events -> simulated investigation -> resolve", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(email!);
    await page.getByLabel("Password", { exact: true }).fill(password!);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/(dashboard|onboarding)/);

    // Consent first: nothing is created until the user confirms.
    await page.goto("/dashboard");
    // "Try the demo" opens the consent dialog; if a demo already exists it is a link, "Open the demo".
    await page.getByRole("button", { name: /Try the demo/ }).or(page.getByRole("link", { name: /Open the demo/ })).first().click();
    const create = page.getByRole("button", { name: "Create demo project" });
    if (await create.isVisible()) await create.click();
    await expect(page).toHaveURL(/\/dashboard\?project=/);

    // 1-2. Dashboard: simulated banner, the spike, and the one callout.
    await expect(page.getByRole("note", { name: "Simulated demo data" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Demo hint" })).toBeVisible();
    await expect(page.getByRole("img", { name: /Error rate over time/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /228 Total events/ })).toBeVisible();
    await page.screenshot({ path: "test-results/demo-1-dashboard.png", fullPage: true });

    // 3. Open the checkout incident.
    await page.getByRole("link", { name: /HTTP 500 on POST \/api\/checkout/ }).first().click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("/api/checkout");
    await page.screenshot({ path: "test-results/demo-2-incident.png", fullPage: true });

    // 4-6. Events and stack trace are there, and the attached investigation is labelled simulated.
    await expect(page.getByText("84").first()).toBeVisible();
    await expect(page.getByText("SIMULATED.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Ranked hypotheses" })).toBeVisible();
    await page.getByRole("button", { name: /Open evidence event/ }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.screenshot({ path: "test-results/demo-3-evidence.png" });
    await page.keyboard.press("Escape");

    // 7. Resolve it (a previous run on a reused account may have left it resolved).
    await ensureOpen(page);
    await page.getByRole("button", { name: /Resolve/ }).first().click();
    await expect(page.getByText(/resolved/i).first()).toBeVisible();

    // Clean up the demo project so the run is repeatable.
    await page.goBack();
    await page.goto("/dashboard");
    const banner = page.getByRole("note", { name: "Simulated demo data" });
    if (await banner.isVisible()) {
      await banner.getByRole("button", { name: /Remove demo/ }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Remove demo" }).click();
      await expect(banner).toBeHidden();
    }
  });
});
