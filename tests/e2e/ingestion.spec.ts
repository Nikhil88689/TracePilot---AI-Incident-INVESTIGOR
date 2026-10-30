import { expect, test } from "@playwright/test";

/**
 * HTTP-level checks of POST /api/v1/events that need no database: they all fail before any
 * key lookup. Deeper behavior (revocation, grouping, concurrency, limits) is covered against a
 * real Postgres by `npm run test:integration`.
 */
const event = {
  external_event_id: "e2e-1",
  message: "boom",
  occurred_at: new Date().toISOString(),
};
const WELL_FORMED_KEY = "tp_live_" + "A".repeat(43);

test.describe("POST /api/v1/events (no database needed)", () => {
  test.beforeEach(async ({ request }) => {
    const health = await (await request.get("/api/health")).json();
    test.skip(!health.supabaseConfigured, "Supabase env is not configured");
  });

  test("rejects requests without credentials with 401 and a Bearer challenge", async ({ request }) => {
    const res = await request.post("/api/v1/events", { data: event });
    expect(res.status()).toBe(401);
    expect(res.headers()["www-authenticate"]).toMatch(/Bearer/);
    expect((await res.json()).error.code).toBe("unauthorized");
  });

  test("rejects malformed keys and the wrong auth scheme", async ({ request }) => {
    for (const authorization of ["Bearer nope", "Basic dXNlcjpwYXNz", "tp_live_" + "A".repeat(43)]) {
      const res = await request.post("/api/v1/events", { data: event, headers: { authorization } });
      expect(res.status(), authorization).toBe(401);
    }
  });

  test("does not accept a browser session cookie in place of a key", async ({ request }) => {
    const res = await request.post("/api/v1/events", { data: event, headers: { cookie: "sb-anything-auth-token=abc" } });
    expect(res.status()).toBe(401);
  });

  test("rejects non-JSON content types with 415", async ({ request }) => {
    const res = await request.post("/api/v1/events", {
      data: "message=boom",
      headers: { "content-type": "text/plain", authorization: `Bearer ${WELL_FORMED_KEY}` },
    });
    expect(res.status()).toBe(415);
  });

  test("rejects an oversized body with 413 before authenticating", async ({ request }) => {
    const res = await request.post("/api/v1/events", {
      data: JSON.stringify({ ...event, attributes: { blob: "x".repeat(300_000) } }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status()).toBe(413);
  });

  test("only POST is supported", async ({ request }) => {
    expect((await request.get("/api/v1/events")).status()).toBe(405);
  });

  test("an ingestion key cannot be used against the dashboard API", async ({ request }) => {
    const res = await request.get("/api/projects", { headers: { authorization: `Bearer ${WELL_FORMED_KEY}` } });
    expect(res.status()).toBe(401);
  });

  test("never echoes the submitted key back in an error", async ({ request }) => {
    const res = await request.post("/api/v1/events", { data: event, headers: { authorization: "Bearer " + "S3CR3T".repeat(8) } });
    expect(await res.text()).not.toContain("S3CR3T");
  });
});
