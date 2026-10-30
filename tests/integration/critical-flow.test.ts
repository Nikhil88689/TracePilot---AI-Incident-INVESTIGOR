/**
 * The critical product flow and its failure modes, on a real Postgres with RLS, through the real handlers:
 *   API key -> POST /api/v1/events -> events list -> incident -> AI investigation (mocked provider)
 *   -> evidence refers to real stored events -> resolve -> "refresh" (fresh reads) -> persistence.
 * The browser version of this flow lives in tests/e2e (it needs real Supabase credentials).
 */
import Anthropic from "@anthropic-ai/sdk";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleAnalyze } from "../../src/lib/ai/analyze-handler";
import type { AiClient } from "../../src/lib/ai/investigate";
import { handleIngest } from "../../src/lib/ingest/handler";
import { generateApiKey } from "../../src/lib/ingest/keys";
import { DEFAULT_EVENT_PARAMS, DEFAULT_INCIDENT_PARAMS } from "../../src/lib/incidents/params";
import { changeIncidentStatus, fetchActivity, fetchEventPage, fetchIncident, fetchIncidentList, fetchLatestAnalysis } from "../../src/lib/incidents/queries";
import { adminPool, createUserAndProject, servicePool } from "./pg-harness";
import { createPgRpc } from "./pg-rpc";
import { createPgIngestStore } from "./pg-store";

const port = Number(process.env.TP_TEST_PG_PORT);
let admin: pg.Pool;
let service: pg.Pool;
const CONFIG = { apiKey: "sk-ant-SECRET", model: "claude-sonnet-5-5", timeoutMs: 5_000 };

beforeAll(() => {
  admin = adminPool(port);
  service = servicePool(port, 8);
});
afterAll(async () => {
  await admin.end();
  await service.end();
});

async function tenant() {
  const { userId, projectId } = await createUserAndProject(admin, "flow");
  const { key, prefix, hash } = generateApiKey();
  const k = await admin.query("insert into public.api_keys (project_id, name, key_prefix, key_hash) values ($1, 'k', $2, $3) returning id", [projectId, prefix, hash]);
  return { userId, projectId, key, keyId: k.rows[0].id as string, db: createPgRpc(admin, userId) };
}
type Tenant = Awaited<ReturnType<typeof tenant>>;

const NOW = new Date();
let n = 0;
const event = (over: Record<string, unknown> = {}) => ({
  external_event_id: `flow-${Date.now()}-${n++}`,
  event_type: "TypeError",
  level: "error",
  message: "checkout total was NaN",
  stack_trace: "TypeError: checkout total was NaN\n    at calculateTotal (/app/checkout.ts:42:11)",
  occurred_at: new Date(NOW.getTime() - 1000 * (n + 1)).toISOString(),
  endpoint: "/api/checkout",
  attributes: { release: "1.4.2" },
  ...over,
});

const send = (t: Pick<Tenant, "key">, body: unknown, opts: { raw?: string; key?: string | null; ip?: string } = {}) =>
  handleIngest(
    new Request("http://localhost/api/v1/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": opts.ip ?? `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
        ...((opts.key === undefined ? t.key : opts.key) ? { authorization: `Bearer ${opts.key === undefined ? t.key : opts.key}` } : {}),
      },
      body: opts.raw ?? JSON.stringify(body),
    }),
    { store: createPgIngestStore(service), now: () => NOW },
  );

/** A provider that cites the first `cite` real events it was shown, read from the prompt like a model would. */
function provider(cite = 2) {
  const create = vi.fn<(p: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>>(async (params) => {
    const prompt = String((params.messages[0] as { content: string }).content);
    const ids = [...prompt.matchAll(/<event id="([0-9a-f-]{36})"/g)].map((m) => m[1]).slice(0, cite);
    return {
      stop_reason: "end_turn", model: CONFIG.model, usage: { input_tokens: 500, output_tokens: 200 },
      content: [{ type: "text", text: JSON.stringify({
        summary: "The checkout total is computed from an undefined price.",
        hypotheses: [{ title: "Missing price on a line item", explanation: "calculateTotal sums an undefined value.", confidence: "medium", evidence: ids.map((id) => ({ event_id: id, why: "same failure site" })) }],
        recommended_steps: [{ step: "Inspect calculateTotal in checkout.ts", rationale: "stack frame" }],
        missing_information: ["Request payloads"], limitations: ["Mocked provider"],
      }) }],
    } as unknown as Anthropic.Message;
  });
  return { client: { messages: { create } } as unknown as AiClient, create };
}

const analyze = (t: Pick<Tenant, "userId" | "db">, incidentId: string, ai: AiClient | null, config: typeof CONFIG | null = CONFIG) =>
  handleAnalyze(
    new Request(`http://app.test/api/v1/incidents/${incidentId}/analyze`, { method: "POST", headers: { "content-type": "application/json", host: "app.test" }, body: "{}" }),
    incidentId,
    { getUser: async () => ({ id: t.userId, email_confirmed_at: "2026-01-01T00:00:00Z" }), getDb: async () => t.db, getConfig: () => config, client: ai ?? undefined },
  );

describe("critical flow", () => {
  it("send event -> events list -> incident -> investigation -> real evidence -> resolve -> persists across refresh", async () => {
    const t = await tenant();
    const first = event();
    const second = event({ message: "checkout total was NaN", occurred_at: new Date(NOW.getTime() - 500).toISOString() });

    // Send (as the SDK / "Send test event" does).
    const res = await send(t, { events: [first, second] });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ accepted: 2, duplicates: 0 });

    // The event appears in the events list.
    const events = await fetchEventPage(t.db, { ...DEFAULT_EVENT_PARAMS, q: "checkout total", since: "all" }, {}, NOW);
    expect(events.total).toBe(2);
    expect(events.items.map((e) => e.externalEventId).sort()).toEqual([first.external_event_id, second.external_event_id].sort());

    // A corresponding incident exists, grouping both events.
    const list = await fetchIncidentList(t.db, DEFAULT_INCIDENT_PARAMS, NOW);
    expect(list.total).toBe(1);
    const incident = (await fetchIncident(t.db, list.items[0].id))!;
    expect(incident).toMatchObject({ status: "open", occurrenceCount: 2, endpoint: "/api/checkout", projectId: t.projectId });
    expect(incident.title).toContain("checkout total was NaN");

    // Run the investigation over the real HTTP handler (auth, CSRF checks, persistence).
    const ai = provider();
    const ran = await analyze(t, incident.id, ai.client);
    expect(ran.status).toBe(200);
    const { analysis } = await ran.json();
    expect(analysis.status).toBe("complete");
    expect(ai.create).toHaveBeenCalledTimes(1);

    // Every evidence link refers to a real stored event of THIS incident.
    const stored = new Set((await admin.query("select e.id from public.events e join public.incident_events ie on ie.event_id = e.id where ie.incident_id = $1", [incident.id])).rows.map((r) => r.id));
    const cited = analysis.hypotheses.flatMap((h: { evidence: { eventId: string; message: string }[] }) => h.evidence);
    expect(cited.length).toBeGreaterThan(0);
    for (const e of cited) {
      expect(stored.has(e.eventId), `event ${e.eventId} exists and belongs to the incident`).toBe(true);
      expect(e.message).toBe("checkout total was NaN"); // enriched from our records, not from model text
    }

    // Resolve, then "refresh": brand-new reads (new connections) must show the persisted state.
    expect(await changeIncidentStatus(t.db, { incidentId: incident.id, to: "resolved", expected: "open" })).toMatchObject({ result: "ok", status: "resolved" });
    const fresh = createPgRpc(admin, t.userId);
    expect((await fetchIncident(fresh, incident.id))?.status).toBe("resolved");
    expect((await fetchActivity(fresh, incident.id)).map((a) => `${a.fromStatus}->${a.toStatus}`)).toEqual(["open->resolved"]);
    expect((await fetchLatestAnalysis(fresh, incident.id))?.id).toBe(analysis.id);
    expect((await fetchIncidentList(fresh, { ...DEFAULT_INCIDENT_PARAMS, status: "resolved" }, NOW)).total).toBe(1);
    expect((await fetchIncidentList(fresh, { ...DEFAULT_INCIDENT_PARAMS, status: "unresolved" }, NOW)).total).toBe(0);
  });

  it("a recurrence after resolving reopens the incident (no silent duplicate)", async () => {
    const t = await tenant();
    await send(t, event());
    const id = (await fetchIncidentList(t.db, DEFAULT_INCIDENT_PARAMS, NOW)).items[0].id;
    await changeIncidentStatus(t.db, { incidentId: id, to: "resolved", expected: "open" });
    await send(t, event({ occurred_at: new Date().toISOString() })); // after the resolution
    expect((await fetchIncidentList(t.db, DEFAULT_INCIDENT_PARAMS, NOW)).total).toBe(1);
    expect((await fetchIncident(t.db, id))?.status).toBe("open");
  });
});

describe("failure cases", () => {
  it("invalid payloads are rejected with precise errors and store nothing", async () => {
    const t = await tenant();
    const bad = [
      { raw: "{not json" },
      { body: { message: "no id", occurred_at: "2026-01-01T00:00:00Z" } },
      { body: { events: [] } },
      { body: event({ level: "catastrophic" }) },
      { body: event({ message: "nul\u0000byte" }) },
      { body: event({ occurred_at: new Date(NOW.getTime() + 3_600_000).toISOString() }) },
      { body: event({ attributes: { a: { b: { c: { d: { e: { f: 1 } } } } } } }) },
    ];
    for (const b of bad) {
      const res = await send(t, "body" in b ? b.body : undefined, "raw" in b ? { raw: b.raw } : {});
      expect([400, 413, 422], JSON.stringify(b).slice(0, 60)).toContain(res.status);
    }
    expect(Number((await admin.query("select count(*) n from public.events where project_id = $1", [t.projectId])).rows[0].n)).toBe(0);
  });

  it("an oversized body is rejected (413) before any database work", async () => {
    const t = await tenant();
    const res = await send(t, event({ message: "x".repeat(300_000) }));
    expect(res.status).toBe(413);
  });

  it("repeated submissions are idempotent: same event id twice stores one event", async () => {
    const t = await tenant();
    const e = event();
    expect((await send(t, e)).status).toBe(201);
    const again = await send(t, e);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ accepted: 0, duplicates: 1 });
    expect(Number((await admin.query("select count(*) n from public.events where project_id = $1", [t.projectId])).rows[0].n)).toBe(1);
    expect(Number((await admin.query("select occurrence_count n from public.incidents where project_id = $1", [t.projectId])).rows[0].n)).toBe(1);
  });

  it("revoked, unknown and malformed keys get the same 401 and store nothing", async () => {
    const t = await tenant();
    await admin.query("update public.api_keys set revoked_at = now() where id = $1", [t.keyId]);
    const other = generateApiKey().key;
    for (const key of [t.key, other, "tp_live_short", null]) {
      const res = await send(t, event(), { key });
      expect(res.status).toBe(401);
      expect(JSON.stringify(await res.json())).not.toContain(t.key);
    }
    expect(Number((await admin.query("select count(*) n from public.events where project_id = $1", [t.projectId])).rows[0].n)).toBe(0);
  });

  it("a database failure during ingestion is a safe 500 that leaks nothing and logs no request data", async () => {
    const t = await tenant();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = { ...createPgIngestStore(service), ingest: async () => { throw new Error("connection refused to db.internal:5432 for message SECRET-PAYLOAD"); } };
    const res = await handleIngest(
      new Request("http://localhost/api/v1/events", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${t.key}` }, body: JSON.stringify(event({ message: "SECRET-PAYLOAD" })) }),
      { store, now: () => NOW },
    );
    expect(res.status).toBe(500);
    const body = JSON.stringify(await res.json());
    expect(body).not.toMatch(/db\.internal|SECRET|connection refused/);
    spy.mockRestore();
  });

  it("another user cannot analyze, resolve or read someone else's incident", async () => {
    const a = await tenant();
    const b = await tenant();
    await send(a, event());
    const id = (await fetchIncidentList(a.db, DEFAULT_INCIDENT_PARAMS, NOW)).items[0].id;
    const ai = provider();
    const res = await analyze(b, id, ai.client);
    expect(res.status).toBe(404);
    expect(ai.create).not.toHaveBeenCalled(); // no provider spend for someone else's incident
    expect(await fetchIncident(b.db, id)).toBeNull();
    expect(await changeIncidentStatus(b.db, { incidentId: id, to: "resolved", expected: "open" })).toMatchObject({ result: "not_found" });
    expect((await fetchIncident(a.db, id))?.status).toBe("open");
  });

  it("missing AI configuration is a clear 503 and nothing is created or spent", async () => {
    const t = await tenant();
    await send(t, event());
    const id = (await fetchIncidentList(t.db, DEFAULT_INCIDENT_PARAMS, NOW)).items[0].id;
    const res = await analyze(t, id, null, null);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("ai_not_configured");
    expect(Number((await admin.query("select count(*) n from public.analyses where incident_id = $1", [id])).rows[0].n)).toBe(0);
  });

  it("a provider timeout is saved as a retryable failure with no provider text, and the next attempt works", async () => {
    const t = await tenant();
    await send(t, event());
    const id = (await fetchIncidentList(t.db, DEFAULT_INCIDENT_PARAMS, NOW)).items[0].id;
    const timeout = { messages: { create: async () => { throw new Anthropic.APIConnectionTimeoutError({ message: "timeout talking to sk-ant-SECRET" }); } } } as unknown as AiClient;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failed = await analyze(t, id, timeout);
    spy.mockRestore();
    expect(failed.status).toBe(504);
    const body = await failed.json();
    expect(body.error).toMatchObject({ code: "timeout", retryable: true });
    expect(JSON.stringify(body)).not.toContain("sk-ant");
    const saved = await fetchLatestAnalysis(t.db, id);
    expect(saved).toMatchObject({ status: "failed", errorCode: "timeout", retryable: true });
    expect((await analyze(t, id, provider().client)).status).toBe(200); // not stuck pending
  });

  it("malformed AI output (not JSON, or citing events it was never shown) stores no hypotheses", async () => {
    const t = await tenant();
    await send(t, event());
    const id = (await fetchIncidentList(t.db, DEFAULT_INCIDENT_PARAMS, NOW)).items[0].id;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const garbage = { messages: { create: async () => ({ stop_reason: "end_turn", model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "Sure! Here is my analysis: <b>nope</b>" }] }) } } as unknown as AiClient;
    expect((await analyze(t, id, garbage)).status).toBe(502);

    const fabricated = { messages: { create: async () => ({ stop_reason: "end_turn", model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: JSON.stringify({ summary: "s", hypotheses: [{ title: "t", explanation: "e", confidence: "high", evidence: [{ event_id: "99999999-9999-4999-8999-999999999999", why: "w" }] }], recommended_steps: [{ step: "s" }], missing_information: [], limitations: [] }) }] }) } } as unknown as AiClient;
    const res = await analyze(t, id, fabricated);
    spy.mockRestore();
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("invalid_evidence");
    const rows = (await admin.query("select status, hypotheses, evidence_event_ids from public.analyses where incident_id = $1 order by created_at", [id])).rows;
    expect(rows.map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(rows.every((r) => r.hypotheses.length === 0 && r.evidence_event_ids.length === 0)).toBe(true);
  });

  it("a double-click (concurrent analyses) spends the provider once", async () => {
    const t = await tenant();
    await send(t, event());
    const id = (await fetchIncidentList(t.db, DEFAULT_INCIDENT_PARAMS, NOW)).items[0].id;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ai = provider();
    const slow: AiClient = { messages: { create: async (...a) => { await gate; return ai.client.messages.create(...a); } } };
    const results = Promise.all([analyze(t, id, slow), analyze(t, id, slow), analyze(t, id, slow)]);
    await new Promise((r) => setTimeout(r, 300));
    release();
    const statuses = (await results).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
    expect(ai.create).toHaveBeenCalledTimes(1);
  });
});
