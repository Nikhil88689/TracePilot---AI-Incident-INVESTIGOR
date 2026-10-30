import { expect, test } from "@playwright/test";

test("health endpoint responds", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.ok()).toBe(true);
  expect(await res.json()).toMatchObject({ status: "ok", service: "tracepilot" });
});

test("landing page links to sign in and sign up", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "Sign in" }).first().click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel("Email")).toBeVisible();
});

test("login form validates input before contacting the auth provider", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("not-an-email");
  await page.getByLabel("Password", { exact: true }).fill("short");
  await page.getByRole("button", { name: "Sign in" }).click();
  // Either validation errors or the not-configured notice must surface; never a silent no-op.
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toBeVisible();
});

test("unknown routes render the 404 page", async ({ page }) => {
  const res = await page.goto("/does-not-exist");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});

test("health endpoint exposes only booleans, never secrets or infrastructure details", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.headers()["cache-control"]).toContain("no-store");
  const body = await res.json();
  expect(Object.keys(body).sort()).toEqual(["aiConfigured", "ingestionConfigured", "service", "status", "supabaseConfigured", "time"]);
  for (const key of ["aiConfigured", "ingestionConfigured", "supabaseConfigured"]) expect(typeof body[key]).toBe("boolean");
  expect(JSON.stringify(body)).not.toMatch(/supabase\.co|sk-ant|eyJ|sb_|vercel\.app/i);
});
