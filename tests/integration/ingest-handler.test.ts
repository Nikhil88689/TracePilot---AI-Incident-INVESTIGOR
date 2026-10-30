/**
 * The complete ingestion pipeline (handler -> validation -> fingerprint -> SQL) against a real
 * Postgres. Only the transport differs from production: a pg pool instead of Supabase RPC.
 */
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleIngest } from "../../src/lib/ingest/handler";
import { generateApiKey } from "../../src/lib/ingest/keys";
import type { IngestStore } from "../../src/lib/ingest/store";
import { adminPool, createUserAndProject, servicePool } from "./pg-harness";
import { createPgIngestStore } from "./pg-store";

const port = Number(process.env.TP_TEST_PG_PORT);
let admin: pg.Pool;
let service: pg.Pool;
let store: IngestStore;

beforeAll(() => {
  admin = adminPool(port);
  service = servicePool(port, 16);
  store = createPgIngestStore(service);
});
afterAll(async () => {
  await admin.end();
  await service.end();
});

type Setup = { projectId: string; key: string; keyId: string };

async function newProject(): Promise<Setup> {
  const { projectId } = await createUserAndProject(admin);
  const { key, prefix, hash } = generateApiKey();
  const { rows } = await admin.query<{ id: string }>(
    "insert into public.api_keys (project_id, name, key_prefix, key_hash) values ($1, 'test', $2, $3) returning id",
    [projectId, prefix, hash],
  );
  return { projectId, key, keyId: rows[0].id };
}

const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
let counter = 0;
const evt = (over: Record<string, unknown> = {}) => ({
  external_event_id: `evt-${Date.now()}-${counter++}-${Math.random().toString(36).slice(2, 8)}`,
  event_type: "TypeError",
  level: "error",
  message: "Cannot read properties of undefined",
  occurred_at: ago(1000),
  endpoint: "/api/checkout",
  ...over,
});

type PostOptions = { key?: string | null; headers?: Record<string, string>; raw?: string; ip?: string; s?: IngestStore };
function post(body: unknown, opts: PostOptions = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": opts.ip ?? `10.0.0.${Math.floor(Math.random() * 250)}-${Math.random()}`,
    ...opts.headers,
  };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  const request = new Request("http://localhost/api/v1/events", {
    method: "POST",
    headers,
    body: opts.raw ?? JSON.stringify(body),
  });
  return handleIngest(request, { store: opts.s ?? store, now: () => NOW });
}

const count = async (sql: string, params: unknown[]) => Number((await admin.query(sql, params)).rows[0].n);
const eventsIn = (projectId: string) => count("select count(*) n from public.events where project_id = $1", [projectId]);
const incidentsIn = (projectId: string) => count("select count(*) n from public.incidents where project_id = $1", [projectId]);

let p: Setup;
beforeEach(async () => {
  p = await newProject();
});

describe("successful ingestion", () => {
  it("accepts a single event (201) and creates an incident", async () => {
    const res = await post(evt(), { key: p.key });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ accepted: 1, duplicates: 0 });
    expect(body.results[0]).toMatchObject({ status: "accepted", occurrence_count: 1 });
    expect(await incidentsIn(p.projectId)).toBe(1);
  });

  it("accepts a batch and returns a result per event", async () => {
    const res = await post({ events: [evt(), evt({ message: "different problem entirely" }), evt()] }, { key: p.key });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.accepted).toBe(3);
    expect(await eventsIn(p.projectId)).toBe(3);
    expect(await incidentsIn(p.projectId)).toBe(2);
  });

  it("stores attributes, stack trace and endpoint", async () => {
    const e = evt({ attributes: { user: { id: 1 }, tags: ["a"] }, stack_trace: "TypeError: x\n    at f (/app/a.ts:1:1)" });
    await post(e, { key: p.key });
    const { rows } = await admin.query("select attributes, stack_trace, endpoint, event_type from public.events where project_id=$1", [p.projectId]);
    expect(rows[0]).toMatchObject({ attributes: { user: { id: 1 }, tags: ["a"] }, endpoint: "/api/checkout", event_type: "TypeError" });
    expect(rows[0].stack_trace).toContain("at f");
  });

  it("applies defaults for event_type and level", async () => {
    const e = { external_event_id: "min-1", message: "minimal", occurred_at: ago(1000) };
    expect((await post(e, { key: p.key })).status).toBe(201);
    const { rows } = await admin.query("select event_type, level from public.events where project_id=$1", [p.projectId]);
    expect(rows[0]).toEqual({ event_type: "error", level: "error" });
  });
});

describe("authentication boundaries", () => {
  it("rejects a missing Authorization header", async () => {
    const res = await post(evt(), { key: null });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
    expect(await eventsIn(p.projectId)).toBe(0);
  });

  it.each(["Bearer", "Bearer nope", "Basic abc", "Bearer tp_live_short", "tp_live_" + "A".repeat(43)])(
    "rejects malformed credentials: %s",
    async (header) => {
      const res = await post(evt(), { key: null, headers: { authorization: header } });
      expect(res.status).toBe(401);
    },
  );

  it("rejects a well-formed but unknown key", async () => {
    expect((await post(evt(), { key: generateApiKey().key })).status).toBe(401);
  });

  it("rejects a revoked key and stores nothing", async () => {
    await admin.query("update public.api_keys set revoked_at = now() where id = $1", [p.keyId]);
    const res = await post(evt(), { key: p.key });
    expect(res.status).toBe(401);
    expect(await eventsIn(p.projectId)).toBe(0);
  });

  it("stops working immediately when a previously working key is revoked", async () => {
    expect((await post(evt(), { key: p.key })).status).toBe(201);
    await admin.query("update public.api_keys set revoked_at = now() where id = $1", [p.keyId]);
    expect((await post(evt(), { key: p.key })).status).toBe(401);
  });

  it("does not leak whether a key exists, was revoked, or is malformed", async () => {
    await admin.query("update public.api_keys set revoked_at = now() where id = $1", [p.keyId]);
    const bodies = await Promise.all(
      [p.key, generateApiKey().key, "garbage"].map(async (k) => (await post(evt(), { key: k })).json()),
    );
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it("ignores any project_id in the body: the key alone decides the project", async () => {
    const other = await newProject();
    const res = await post({ ...evt(), project_id: other.projectId }, { key: p.key });
    expect(res.status).toBe(201);
    expect(await eventsIn(p.projectId)).toBe(1);
    expect(await eventsIn(other.projectId)).toBe(0);
  });

  it("isolates projects: one project's key never writes to or sees another's data", async () => {
    const other = await newProject();
    const e = evt({ external_event_id: "shared-id" });
    expect((await post(e, { key: p.key })).status).toBe(201);
    // Same external id under another project's key is a separate event, not a duplicate.
    const res = await post(e, { key: other.key });
    expect((await res.json()).results[0].status).toBe("accepted");
    expect(await eventsIn(p.projectId)).toBe(1);
    expect(await eventsIn(other.projectId)).toBe(1);
  });

  it("does not accept a session cookie in place of a key", async () => {
    const res = await post(evt(), { key: null, headers: { cookie: "sb-access-token=anything" } });
    expect(res.status).toBe(401);
  });

  it("throttles repeated authentication failures from one client", async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 200)}-${Date.now()}`;
    const statuses: number[] = [];
    for (let i = 0; i < 33; i++) statuses.push((await post(evt(), { key: generateApiKey().key, ip })).status);
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(30).every((s) => s === 429)).toBe(true);
  });
});

describe("request validation", () => {
  const rejected = async (body: unknown, status: number, opts: PostOptions = {}) => {
    const res = await post(body, { key: p.key, ...opts });
    expect(res.status).toBe(status);
    expect(await eventsIn(p.projectId)).toBe(0);
    return res.json();
  };

  it("rejects the wrong content type", async () => {
    await rejected(evt(), 415, { headers: { "content-type": "text/plain" } });
  });

  it("rejects malformed JSON", async () => {
    const body = await rejected(null, 400, { raw: "{not json" });
    expect(body.error.code).toBe("invalid_json");
  });

  it("rejects bodies that are not objects", async () => {
    await rejected(null, 422, { raw: "42" });
    await rejected([evt()], 422);
    await rejected(null, 422, { raw: '"hello"' });
  });

  it("rejects an empty or non-array batch", async () => {
    await rejected({ events: [] }, 422);
    await rejected({ events: "nope" }, 422);
  });

  it("rejects batches over the limit with 413", async () => {
    const body = await rejected({ events: Array.from({ length: 51 }, () => evt()) }, 413);
    expect(body.error.code).toBe("too_many_events");
  });

  it("accepts exactly the maximum batch", async () => {
    const res = await post({ events: Array.from({ length: 50 }, () => evt()) }, { key: p.key });
    expect(res.status).toBe(201);
    expect((await res.json()).accepted).toBe(50);
  });

  it("rejects oversized bodies (declared and actual)", async () => {
    const huge = { events: [evt({ attributes: { blob: "x".repeat(300_000) } })] };
    await rejected(huge, 413, { headers: { "content-length": "999999" } });
    // No content-length: the streaming reader must still stop at the limit.
    await rejected(huge, 413);
  });

  it("reports which field of which event is wrong, and stores nothing (all-or-nothing)", async () => {
    const res = await post({ events: [evt(), evt({ message: "" }), evt({ level: "loud" })] }, { key: p.key });
    expect(res.status).toBe(422);
    const { error } = await res.json();
    expect(error.issues.map((i: { path: string }) => i.path)).toEqual(
      expect.arrayContaining(["events[1].message", "events[2].level"]),
    );
    expect(await eventsIn(p.projectId)).toBe(0);
    expect(await incidentsIn(p.projectId)).toBe(0);
  });

  it.each([
    ["not a timestamp", "yesterday"],
    ["no timezone", "2026-10-29T12:00:00"],
    ["impossible date", "2026-02-31T12:00:00Z"],
    ["epoch number", 1761739200],
  ])("rejects an invalid timestamp: %s", async (_label, value) => {
    await rejected(evt({ occurred_at: value }), 422);
  });

  it("rejects timestamps in the future beyond clock skew, and older than 30 days", async () => {
    await rejected(evt({ occurred_at: new Date(NOW.getTime() + 10 * 60_000).toISOString() }), 422);
    await rejected(evt({ occurred_at: ago(31 * 24 * 3600_000) }), 422);
  });

  it("accepts a small amount of forward clock skew", async () => {
    const res = await post(evt({ occurred_at: new Date(NOW.getTime() + 60_000).toISOString() }), { key: p.key });
    expect(res.status).toBe(201);
  });

  it("accepts timestamps with a UTC offset and stores the same instant", async () => {
    const instant = new Date(NOW.getTime() - 60_000);
    const offset = instant.toISOString().replace("Z", "+00:00");
    await post(evt({ occurred_at: offset }), { key: p.key });
    const { rows } = await admin.query("select occurred_at from public.events where project_id=$1", [p.projectId]);
    expect(rows[0].occurred_at.getTime()).toBe(instant.getTime());
  });

  it.each([
    ["bad external id characters", { external_event_id: "has spaces/slash" }],
    ["empty external id", { external_event_id: "" }],
    ["too-long external id", { external_event_id: "x".repeat(129) }],
    ["too-long message", { message: "m".repeat(4001) }],
    ["too-long stack trace", { stack_trace: "s".repeat(20_001) }],
    ["NUL in message", { message: "bad\u0000message" }],
    ["NUL in attributes", { attributes: { k: "bad\u0000value" } }],
    ["attributes not an object", { attributes: [1, 2] }],
    ["attributes too deep", { attributes: { a: { b: { c: { d: { e: { f: 1 } } } } } } }],
    ["attributes too large", { attributes: { a: "x".repeat(17_000) } }],
  ])("rejects %s", async (_label, over) => {
    await rejected(evt(over), 422);
  });
});

describe("grouping and idempotency", () => {
  const stack = (line: number) => `TypeError: boom\n    at calculateTotal (/srv/app/checkout.ts:${line}:11)\n    at handler (/srv/app/route.ts:8:3)`;

  it("groups similar errors (varying ids and line numbers) into one incident", async () => {
    await post(evt({ message: "Order 4812 not found", stack_trace: stack(42) }), { key: p.key });
    await post(evt({ message: "Order 9930 not found", stack_trace: stack(45) }), { key: p.key });
    expect(await incidentsIn(p.projectId)).toBe(1);
    const { rows } = await admin.query("select occurrence_count from public.incidents where project_id=$1", [p.projectId]);
    expect(rows[0].occurrence_count).toBe(2);
  });

  it("separates genuinely different errors", async () => {
    await post(evt({ message: "Order 1 not found" }), { key: p.key });
    await post(evt({ message: "Payment declined" }), { key: p.key });
    await post(evt({ message: "Order 2 not found", endpoint: "/api/other" }), { key: p.key });
    expect(await incidentsIn(p.projectId)).toBe(3);
  });

  it("honours a custom fingerprint", async () => {
    await post(evt({ message: "one", fingerprint: "checkout-flow" }), { key: p.key });
    await post(evt({ message: "completely different", fingerprint: "checkout-flow" }), { key: p.key });
    expect(await incidentsIn(p.projectId)).toBe(1);
  });

  it("treats a retried request as a duplicate: 200, nothing changes", async () => {
    const e = evt();
    expect((await post(e, { key: p.key })).status).toBe(201);
    const retry = await post(e, { key: p.key });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ accepted: 0, duplicates: 1 });
    const { rows } = await admin.query("select occurrence_count from public.incidents where project_id=$1", [p.projectId]);
    expect(rows[0].occurrence_count).toBe(1);
    expect(await eventsIn(p.projectId)).toBe(1);
  });

  it("handles a batch that mixes new and previously seen events", async () => {
    const seen = evt();
    await post(seen, { key: p.key });
    const res = await post({ events: [seen, evt(), evt({ message: "another" })] }, { key: p.key });
    expect((await res.json())).toMatchObject({ accepted: 2, duplicates: 1 });
  });

  it("processes concurrent requests without losing or double-counting events", async () => {
    const N = 30;
    const responses = await Promise.all(
      Array.from({ length: N }, () => post(evt({ message: "Concurrent failure" }), { key: p.key })),
    );
    expect(responses.every((r) => r.status === 201)).toBe(true);
    const { rows } = await admin.query("select occurrence_count from public.incidents where project_id=$1", [p.projectId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].occurrence_count).toBe(N);
    expect(await eventsIn(p.projectId)).toBe(N);
  });

  it("does not double-count when the same event is retried concurrently", async () => {
    const e = evt();
    const responses = await Promise.all(Array.from({ length: 15 }, () => post(e, { key: p.key })));
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(14);
    expect(await eventsIn(p.projectId)).toBe(1);
  });
});

describe("rate limiting", () => {
  it("allows up to the per-key budget and then returns 429 with Retry-After", async () => {
    // 12 batches x 50 events = the full 600/minute budget.
    for (let i = 0; i < 12; i++) {
      const res = await post({ events: Array.from({ length: 50 }, () => evt({ message: `m${i}` })) }, { key: p.key });
      expect(res.status).toBe(201);
    }
    const limited = await post(evt(), { key: p.key });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(limited.headers.get("x-ratelimit-limit")).toBe("600");
    expect(await eventsIn(p.projectId)).toBe(600);
  });

  it("limits each key independently", async () => {
    const other = await newProject();
    for (let i = 0; i < 12; i++) {
      await post({ events: Array.from({ length: 50 }, () => evt()) }, { key: p.key });
    }
    expect((await post(evt(), { key: p.key })).status).toBe(429);
    expect((await post(evt(), { key: other.key })).status).toBe(201);
  });
});

describe("failure handling", () => {
  it("returns a generic 500 without internals and persists nothing when processing fails", async () => {
    const failing: IngestStore = {
      ...store,
      ingest: async () => {
        throw new Error('relation "secret_table" does not exist');
      },
    };
    const res = await post(evt(), { key: p.key, s: failing });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("secret_table");
    expect(text).not.toContain(p.key);
    expect(await eventsIn(p.projectId)).toBe(0);
  });

  it("returns 500 (not a crash) when authentication storage fails", async () => {
    const failing: IngestStore = { ...store, authenticate: async () => { throw new Error("db down"); } };
    expect((await post(evt(), { key: p.key, s: failing })).status).toBe(500);
  });
});

describe("secret handling", () => {
  it("stores only a hash of the key, never the plaintext", async () => {
    const { rows } = await admin.query("select key_hash, key_prefix from public.api_keys where id = $1", [p.keyId]);
    expect(rows[0].key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].key_hash).not.toContain(p.key);
    expect(p.key.startsWith(rows[0].key_prefix)).toBe(true);
    expect(rows[0].key_prefix.length).toBe(12);

    const dump = await admin.query("select to_jsonb(k) j from public.api_keys k where id = $1", [p.keyId]);
    expect(JSON.stringify(dump.rows[0].j)).not.toContain(p.key.slice(12));
  });

  it("never writes the key to the console, even on server errors", async () => {
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    try {
      const failing: IngestStore = { ...store, ingest: async () => { throw new Error("kaboom"); } };
      await post(evt(), { key: p.key, s: failing });
    } finally {
      console.error = original;
    }
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain(p.key.slice(8));
  });
});
