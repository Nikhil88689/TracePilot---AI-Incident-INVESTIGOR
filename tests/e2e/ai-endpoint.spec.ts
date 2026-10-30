import { expect, test } from "@playwright/test";

/**
 * HTTP-level checks of POST /api/v1/incidents/[incidentId]/analyze that need no database or AI key:
 * every one of them is rejected before any work happens. The behaviour behind authentication
 * (evidence selection, provider calls, persistence) is covered against a real Postgres by
 * `npm run test:integration`.
 */
const ID = "00000000-0000-4000-8000-000000000000";
const URL = `/api/v1/incidents/${ID}/analyze`;
const JSON_HEADERS = { "content-type": "application/json" };

test.describe("POST /api/v1/incidents/[incidentId]/analyze (signed out)", () => {
  test.beforeEach(async ({ request }) => {
    const health = await (await request.get("/api/health")).json();
    test.skip(!health.supabaseConfigured, "Supabase env is not configured");
  });

  test("requires a session: 401 JSON, never an analysis", async ({ request }) => {
    const res = await request.post(URL, { headers: JSON_HEADERS, data: {} });
    expect(res.status()).toBe(401);
    expect((await res.json()).error).toMatchObject({ code: "unauthorized", retryable: false });
    expect(res.headers()["cache-control"]).toBe("no-store");
  });

  test("does not accept an ingestion API key as credentials", async ({ request }) => {
    const res = await request.post(URL, { headers: { ...JSON_HEADERS, authorization: "Bearer tp_live_" + "A".repeat(43) }, data: {} });
    expect(res.status()).toBe(401);
  });

  test("does not accept a forged session cookie", async ({ request }) => {
    const res = await request.post(URL, { headers: { ...JSON_HEADERS, cookie: "sb-anything-auth-token=forged" }, data: {} });
    expect(res.status()).toBe(401);
  });

  test("rejects cross-site requests before doing anything else", async ({ request }) => {
    const res = await request.post(URL, { headers: { ...JSON_HEADERS, origin: "https://evil.example" }, data: {} });
    expect(res.status()).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden");
  });

  test("rejects form-style posts (the shape a cross-site HTML form can send)", async ({ request }) => {
    const res = await request.post(URL, { headers: { "content-type": "application/x-www-form-urlencoded" }, data: "a=b" });
    expect(res.status()).toBe(415);
  });

  test("only POST is supported", async ({ request }) => {
    expect((await request.get(URL)).status()).toBe(405);
  });

  test("authenticates before revealing anything about the id or body", async ({ request }) => {
    const bad = await request.post("/api/v1/incidents/not-a-uuid/analyze", { headers: JSON_HEADERS, data: "{oops" });
    expect(bad.status()).toBe(401);
  });

  test("never echoes secrets or internals", async ({ request }) => {
    const res = await request.post(URL, { headers: { ...JSON_HEADERS, authorization: "Bearer " + "S3CR3T".repeat(8) }, data: {} });
    const text = await res.text();
    expect(text).not.toContain("S3CR3T");
    expect(text).not.toMatch(/ANTHROPIC|sk-ant|stack|supabase/i);
  });
});
