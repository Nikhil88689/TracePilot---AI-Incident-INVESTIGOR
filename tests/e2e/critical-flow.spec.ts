import { expect, test } from "@playwright/test";
import { ensureOpen } from "./helpers";

/**
 * The critical flow in a real browser against real Supabase:
 *   sign in -> select a project -> send a test event -> it is in the events list -> an incident exists ->
 *   open it -> run (or view) the AI investigation -> evidence links open REAL stored events -> resolve ->
 *   reload and confirm it persisted.
 *
 * Needs a confirmed user (E2E_EMAIL / E2E_PASSWORD), applied migrations, and NEXT_PUBLIC_SITE_URL pointing
 * at the server under test (the test event goes through the HTTP ingestion API). Skipped, never faked,
 * without credentials. If ANTHROPIC_API_KEY is not configured on that server the AI step verifies the
 * honest "not configured" state instead and the evidence check is reported as skipped (the same evidence
 * contract is covered without a browser in tests/integration/critical-flow.test.ts and, with real stored
 * events and no AI key, by demo-walkthrough.spec.ts).
 */
const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;

test.describe("critical flow (needs E2E_EMAIL / E2E_PASSWORD and applied migrations)", () => {
  test.skip(!email || !password, "E2E_EMAIL / E2E_PASSWORD not set");
  test.use({ viewport: { width: 1440, height: 900 } });

  test("event -> events list -> incident -> investigation -> evidence -> resolve -> persists", async ({ page }) => {
    test.setTimeout(150_000); // includes a real (or stubbed) AI call of up to 60 s
    // Sign in.
    await page.goto("/login");
    await page.getByLabel("Email").fill(email!);
    await page.getByLabel("Password", { exact: true }).fill(password!);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/(dashboard|onboarding)/);

    // Select a project (the first real one, never the simulated demo).
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Project overview" })).toBeVisible();
    await page.getByRole("button", { name: /Project:/ }).click();
    await expect(page.getByRole("menuitemradio").first()).toBeVisible(); // wait for the menu before inspecting it
    const real = page.getByRole("menuitemradio").filter({ hasNotText: /All projects|Demo \(simulated/ }).first();
    if (await real.count()) {
      await real.click();
      await expect(page).toHaveURL(/project=/);
    } else await page.keyboard.press("Escape");
    await expect(page.getByRole("menuitemradio")).toHaveCount(0); // the menu closes after choosing

    // Send a test event through the real ingestion API.
    await page.getByRole("button", { name: "Send test event" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Send test event" });
    await dialog.getByRole("button", { name: "Send test event" }).click();
    await expect(dialog.getByRole("status")).toContainText("ingestion API", { timeout: 20_000 });
    await page.keyboard.press("Escape");

    // It appears in the events list.
    await page.goto("/events");
    await page.getByRole("searchbox").fill("checkout total");
    const row = page.getByRole("list", { name: "Events" }).getByRole("button").first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    await expect(page.getByRole("region", { name: "Event details" })).toContainText("calculateTotal");

    // A corresponding incident exists; open it.
    await page.goto("/incidents?q=checkout%20total");
    await page.getByRole("table").getByRole("link", { name: /checkout total was NaN/ }).first().click();
    await expect(page).toHaveURL(/\/incidents\/[0-9a-f-]{36}/);
    const incidentUrl = page.url();

    await ensureOpen(page); // earlier runs may have left it resolved

    // Investigate. Wait for a terminal state: a result, or an honest failure.
    const run = page.getByRole("button", { name: /Investigate with AI|Re-run investigation|Try again/ });
    const notConfigured = page.getByText(/AI analysis is not configured/);
    const hypotheses = page.getByRole("heading", { name: "Ranked hypotheses" });
    // Without ANTHROPIC_API_KEY the button is disabled and the panel explains why (never a silent no-op).
    if (await run.isDisabled()) await expect(notConfigured).toBeVisible();
    else {
      // A previous run may have left a saved analysis on screen, so wait for THIS request to finish before reading it.
      const answered = page.waitForResponse((r) => r.url().endsWith("/analyze") && r.request().method() === "POST", { timeout: 70_000 });
      await run.click();
      expect((await answered).status()).toBe(200);
      await expect(hypotheses).toBeVisible();
      await expect(page.getByRole("button", { name: "Re-run investigation" })).toBeEnabled();
    }

    if (await hypotheses.isVisible()) {
      // Evidence links open real stored events.
      const evidence = page.getByRole("button", { name: /Open evidence event/ }).first();
      const label = (await evidence.getAttribute("aria-label")) ?? "";
      // The button names the event's internal id and time; the dialog shows the stored record (message, external id, timestamp).
      const time = /from (\d\d:\d\d:\d\d) UTC/.exec(label)?.[1];
      expect(time, "evidence button names the event's time").toBeTruthy();
      await evidence.click();
      const evidenceDialog = page.getByRole("dialog");
      await expect(evidenceDialog).toContainText("checkout total was NaN");
      await expect(evidenceDialog).toContainText(`T${time}`); // same instant as the button: it is the record that was cited
      await page.keyboard.press("Escape");
    } else {
      test.info().annotations.push({ type: "note", description: "ANTHROPIC_API_KEY not configured on the server: evidence check skipped here" });
    }

    // Resolve, reload, and confirm persistence.
    await page.getByRole("button", { name: "Resolve" }).click();
    await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible();
    await page.goto(incidentUrl);
    await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible();
    await page.getByRole("button", { name: "Reopen" }).click(); // leave the account as we found it
    await expect(page.getByRole("button", { name: "Acknowledge" })).toBeVisible();
  });
});
