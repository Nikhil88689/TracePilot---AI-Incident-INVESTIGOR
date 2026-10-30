import { describe, expect, it, vi } from "vitest";
import { handleIngest } from "./handler";
import { generateApiKey, hashApiKey } from "./keys";
import type { IngestStore, PreparedEvent } from "./store";

const { key } = generateApiKey();
const NOW = new Date("2026-10-29T12:00:00Z");

function fakeStore(over: Partial<IngestStore> = {}): IngestStore & { calls: { ingest: unknown[][] } } {
  const calls = { ingest: [] as unknown[][] };
  return {
    calls,
    authenticate: vi.fn(async (hash: string) => (hash === hashApiKey(key) ? { keyId: "k1", projectId: "p1" } : null)),
    consumeRateLimit: vi.fn(async () => ({ allowed: true, count: 1, retryAfter: 1 })),
    ingest: vi.fn(async (projectId, events) => {
      calls.ingest.push([projectId, events]);
      return events.map((e: PreparedEvent) => ({ external_event_id: e.external_event_id, status: "accepted" as const, incident_id: "i1", occurrence_count: 1 }));
    }),
    ...over,
  };
}

const event = (over = {}) => ({ external_event_id: "e1", message: "boom", occurred_at: "2026-10-29T11:59:00Z", ...over });
const request = (body: unknown, headers: Record<string, string> = {}, raw?: string) =>
  new Request("http://localhost/api/v1/events", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...headers },
    body: raw ?? JSON.stringify(body),
  });
const run = (req: Request, store = fakeStore()) => handleIngest(req, { store, now: () => NOW });

describe("handleIngest (fast, no database)", () => {
  it("authenticates, validates, and stores for the project derived from the key", async () => {
    const store = fakeStore();
    const res = await run(request({ ...event(), project_id: "attacker-project" }), store);
    expect(res.status).toBe(201);
    expect(store.calls.ingest[0][0]).toBe("p1");
    expect(JSON.stringify(store.calls.ingest[0][1])).not.toContain("attacker-project");
    expect(store.calls.ingest[0][1]).toMatchObject([{ fingerprint: expect.stringMatching(/^[0-9a-f]{32}$/), severity: "high", title: "boom" }]);
  });

  it("returns 401 without touching the database when no usable key is sent", async () => {
    const store = fakeStore();
    const res = await run(request(event(), { authorization: "" }), store);
    expect(res.status).toBe(401);
    expect(store.authenticate).not.toHaveBeenCalled();
    expect(store.ingest).not.toHaveBeenCalled();
  });

  it("returns 401 for a revoked/unknown key and never ingests", async () => {
    const store = fakeStore({ authenticate: vi.fn(async () => null) });
    expect((await run(request(event()), store)).status).toBe(401);
    expect(store.ingest).not.toHaveBeenCalled();
  });

  it("validates before ingesting: 400 / 413 / 415 / 422", async () => {
    const store = fakeStore();
    expect((await run(request(null, {}, "{bad"), store)).status).toBe(400);
    expect((await run(request(event(), { "content-type": "text/plain" }), store)).status).toBe(415);
    expect((await run(request(event(), { "content-length": "999999" }), store)).status).toBe(413);
    expect((await run(request({ events: Array.from({ length: 51 }, (_, i) => event({ external_event_id: `e${i}` })) }), store)).status).toBe(413);
    expect((await run(request(event({ occurred_at: "2020-01-01T00:00:00Z" })), store)).status).toBe(422);
    expect(store.ingest).not.toHaveBeenCalled();
  });

  it("rejects an oversized body even without a Content-Length header", async () => {
    const store = fakeStore();
    const res = await run(request(null, {}, JSON.stringify(event({ attributes: { x: "y".repeat(300_000) } }))), store);
    expect(res.status).toBe(413);
    expect(store.ingest).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After when the key is over its budget", async () => {
    const store = fakeStore({ consumeRateLimit: vi.fn(async () => ({ allowed: false, count: 700, retryAfter: 17 })) });
    const res = await run(request(event()), store);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
    expect(store.ingest).not.toHaveBeenCalled();
  });

  it("charges the rate limit by number of events", async () => {
    const store = fakeStore();
    await run(request({ events: [event({ external_event_id: "a" }), event({ external_event_id: "b" })] }), store);
    expect(store.consumeRateLimit).toHaveBeenCalledWith("key:k1", 2, 600, 60);
  });

  it("returns 200 (not 201) when every event was a duplicate", async () => {
    const store = fakeStore({
      ingest: vi.fn(async (_p: string, events: PreparedEvent[]) => events.map((e) => ({ external_event_id: e.external_event_id, status: "duplicate" as const, incident_id: "i1", occurrence_count: 3 }))),
    });
    const res = await run(request(event()), store);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: 0, duplicates: 1 });
  });

  it("returns a generic 500 and logs no secrets when the store throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = fakeStore({ ingest: vi.fn(async () => { throw new Error("pg: relation secret_table missing"); }) });
    const res = await run(request(event()), store);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret_table");
    expect(JSON.stringify(log.mock.calls)).not.toContain(key.slice(8));
    log.mockRestore();
  });
});
