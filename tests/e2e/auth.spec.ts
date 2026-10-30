import { expect, test } from "@playwright/test";

test.describe("auth screens", () => {
  test("login shows the Welcome back card with show/hide password and a reset link", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

    const password = page.getByLabel("Password", { exact: true });
    await expect(password).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "Show password" }).click();
    await expect(password).toHaveAttribute("type", "text");

    await page.getByRole("link", { name: "Forgot password?" }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  });

  test("login shows inline validation errors", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("not-an-email");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Enter a valid email address.")).toBeVisible();
    await expect(page.getByText("Enter your password.")).toBeVisible();
  });

  test("signup lists password requirements and validates before contacting Supabase", async ({ page }) => {
    await page.goto("/signup");
    const rules = page.getByRole("list", { name: "Password requirements" });
    await expect(rules).toContainText("At least 8 characters");
    await page.getByLabel("Password", { exact: true }).fill("abcdefg1");
    await expect(rules).toContainText("At least 8 characters (met)");

    await page.getByLabel("Password", { exact: true }).fill("weak");
    await page.getByLabel("Full name").fill("Ada");
    await page.getByLabel("Email").fill("ada@example.com");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText(/Password needs:/)).toBeVisible();

    await expect(page.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
  });

  test("terms and privacy pages are reachable without signing in", async ({ page }) => {
    await page.goto("/terms");
    await expect(page.getByRole("heading", { name: "Terms of use" })).toBeVisible();
    await page.goto("/privacy");
    await expect(page.getByRole("heading", { name: "Privacy notice" })).toBeVisible();
  });

  test("reset-password without a recovery session sends the user to request a new link", async ({ page, request }) => {
    const health = await (await request.get("/api/health")).json();
    test.skip(!health.supabaseConfigured, "Supabase env is not configured");
    await page.goto("/reset-password");
    await expect(page).toHaveURL(/\/forgot-password\?error=expired/);
    await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText("invalid or has expired");
  });

  test("an invalid email link lands on the login page with a clear message", async ({ page, request }) => {
    const health = await (await request.get("/api/health")).json();
    test.skip(!health.supabaseConfigured, "Supabase env is not configured");
    await page.goto("/auth/callback?code=not-a-real-code");
    await expect(page).toHaveURL(/\/login\?error=callback/);
    await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText("invalid or has expired");
  });
});

test.describe("route protection", () => {
  test.beforeEach(async ({ request }) => {
    const health = await (await request.get("/api/health")).json();
    test.skip(!health.supabaseConfigured, "Supabase env is not configured");
  });

  for (const path of ["/onboarding", "/dashboard", "/incidents", "/settings"]) {
    test(`${path} redirects signed-out visitors to /login`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(path).replace(/%/g, "%")}`));
    });
  }

  test("the projects API returns 401 JSON when signed out", async ({ request }) => {
    expect((await request.get("/api/projects")).status()).toBe(401);
    const post = await request.post("/api/projects", {
      data: { name: "x", environment: "production", requestId: "22222222-2222-4222-8222-222222222222" },
    });
    expect(post.status()).toBe(401);
  });
});

const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;

test.describe("onboarding (needs E2E_EMAIL / E2E_PASSWORD and applied migrations)", () => {
  test.skip(!email || !password, "E2E_EMAIL / E2E_PASSWORD not set");

  test("a signed-in user can sign in and reach onboarding or the dashboard", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(email!);
    await page.getByLabel("Password", { exact: true }).fill(password!);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/(onboarding|dashboard)/);
    await expect(page.getByText(email!).first()).toBeVisible();
  });
});
