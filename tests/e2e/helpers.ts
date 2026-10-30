import { expect, type Page } from "@playwright/test";

/**
 * Brings the incident detail page to the "open" state whatever state earlier runs left it in. The signed-in specs
 * reuse one account, and the same test error always groups into the same incident, so state persists between runs.
 */
export async function ensureOpen(page: Page) {
  const resolve = page.getByRole("button", { name: "Resolve", exact: true });
  const reopen = page.getByRole("button", { name: "Reopen", exact: true });
  const acknowledge = page.getByRole("button", { name: "Acknowledge", exact: true });
  await expect(resolve.or(reopen)).toBeVisible();
  if (await acknowledge.isVisible()) return; // already open
  if (await resolve.isVisible()) await resolve.click(); // investigating -> resolved
  await expect(reopen).toBeVisible();
  await reopen.click(); // resolved -> open
  await expect(acknowledge).toBeVisible();
}
