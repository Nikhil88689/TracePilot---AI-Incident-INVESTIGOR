import { expect, test } from "@playwright/test";

/** Needs no credentials and no database: headers, redirects, CORS, and a real-browser layout/console check of public pages. */

test("every response carries the baseline security headers", async ({ request }) => {
  for (const path of ["/", "/login", "/api/health", "/does-not-exist"]) {
    const res = await request.get(path);
    const h = res.headers();
    expect(h["x-content-type-options"], path).toBe("nosniff");
    expect(h["x-frame-options"], path).toBe("DENY");
    expect(h["referrer-policy"], path).toBe("strict-origin-when-cross-origin");
    expect(h["content-security-policy"], path).toContain("frame-ancestors 'none'");
    expect(h["x-powered-by"], path).toBeUndefined();
  }
});

test("no CORS headers are granted to other origins", async ({ request }) => {
  for (const path of ["/api/health", "/api/v1/events"]) {
    const res = await request.fetch(path, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(res.headers()["access-control-allow-origin"], path).toBeUndefined();
  }
});

test("?next= cannot be used as an open redirect", async ({ request }) => {
  const health = await (await request.get("/api/health")).json();
  test.skip(!health.supabaseConfigured, "Supabase env is not configured");
  for (const next of ["https://evil.example", "//evil.example", "/\evil.example", "javascript:alert(1)"]) {
    const res = await request.get(`/auth/callback?code=bogus&next=${encodeURIComponent(next)}`, { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    const location = res.headers().location ?? "";
    expect(new URL(location).host, next).toBe(new URL(res.url()).host); // always back to our own origin
    expect(location).not.toContain("evil.example");
  }
});

test("ingestion rejects oversize bodies before authenticating and never reflects the key", async ({ request }) => {
  const res = await request.post("/api/v1/events", {
    headers: { "content-type": "application/json", authorization: "Bearer tp_live_" + "A".repeat(43) },
    data: JSON.stringify({ message: "x".repeat(300_000) }),
  });
  expect([401, 413, 503]).toContain(res.status());
  expect(await res.text()).not.toContain("tp_live_AAAA");
});

for (const width of [1440, 1024, 390]) {
  test.describe(`public pages at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    for (const path of ["/", "/login", "/signup", "/privacy", "/terms"]) {
      test(`${path}: no horizontal overflow, no console errors, no hydration warnings`, async ({ page }) => {
        const problems: string[] = [];
        page.on("console", (m) => {
          if (m.type() === "error" || (m.type() === "warning" && /hydrat|key|did not match/i.test(m.text()))) problems.push(m.text());
        });
        page.on("pageerror", (e) => problems.push(e.message));
        await page.goto(path, { waitUntil: "networkidle" });
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, "horizontal overflow (px)").toBeLessThanOrEqual(0);
        expect(problems).toEqual([]);
        await page.screenshot({ path: `screenshots/public${path === "/" ? "-home" : path.replace("/", "-")}-${width}.png`, fullPage: true });
      });
    }
  });
}
