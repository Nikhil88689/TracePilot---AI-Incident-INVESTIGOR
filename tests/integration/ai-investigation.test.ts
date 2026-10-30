/**
 * AI investigation against a REAL Postgres (RLS active, real SQL functions). Only the Anthropic
 * provider is mocked, so these tests exercise evidence selection, persistence, authorization,
 * de-duplication, rate limiting and the HTTP handler exactly as production runs them.
 */
import Anthropic from "@anthropic-ai/sdk";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleAnalyze } from "../../src/lib/ai/analyze-handler";
import { investigateIncident, type AiClient } from "../../src/lib/ai/investigate";
import { fetchEvidenceEvents, fetchLatestAnalysis, setAnalysisStep } from "../../src/lib/incidents/queries";
import { adminPool, buildEvent, createUserAndProject, ingestEvents, servicePool } from "./pg-harness";
import { createPgRpc } from "./pg-rpc";

const port = Number(process.env.TP_TEST_PG_PORT);
let admin: pg.Pool;
let service: pg.Pool;

const CONFIG = { apiKey: "sk-ant-test", model: "claude-sonnet-5-5", timeoutMs: 5_000 };
const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

beforeAll(() => {
  admin = adminPool(port);
  service = servicePool(port, 10);
});
afterAll(async () => {
  await admin.end();
  await service.end();
});

/** A fresh user + project + one incident with `n` events of varying shapes. */
async function incidentWith(events: Parameters<typeof buildEvent>[0][]) {
  const u = await createUserAndProject(admin, "ai");
  const built = events.map((e) => buildEvent({ fingerprint: "f".repeat(32), ...e }));
  let incidentId = "";
  // ingest_events accepts at most 100 events per call, like the real API's batches.
  for (let i = 0; i < built.length; i += 50) {
    const results = await ingestEvents(service, u.projectId, built.slice(i, i + 50));
    incidentId ||= results[0].incident_id;
  }
  const ids = (await admin.query<{ id: string; occurred_at: Date; message: string }>(
    "select e.id, e.occurred_at, e.message from public.events e join public.incident_events ie on ie.event_id = e.id where ie.incident_id = $1 order by e.occurred_at",
    [incidentId],
  )).rows;
  return { ...u, incidentId, events: ids, db: createPgRpc(admin, u.userId) };
}

type Ev = { id: string };
const goodReply = (events: Ev[], over: Record<string, unknown> = {}) => ({
  summary: "The cart reads items before they are loaded.",
  hypotheses: [
    { title: "Items undefined", explanation: "Events read a property of undefined.", confidence: "medium", evidence: events.slice(0, 2).map((e, i) => ({ event_id: e.id, why: `event ${i} shows it` })) },
  ],
  recommended_steps: [{ step: "Read addItem", rationale: "stack" }, { step: "Compare releases" }, { step: "Check promo path" }],
  missing_information: ["Earlier events"],
  limitations: ["Selection of events only"],
  ...over,
});
const message = (obj: unknown) =>
  ({ stop_reason: "end_turn", model: "claude-sonnet-5-5", usage: { input_tokens: 1500, output_tokens: 700 }, content: [{ type: "text", text: JSON.stringify(obj) }] }) as unknown as Anthropic.Message;
function provider(impl: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>) {
  const create = vi.fn<(params: Anthropic.MessageCreateParamsNonStreaming, options?: unknown) => Promise<Anthropic.Message>>(async (params) => impl(params));
  return { client: { messages: { create } } as unknown as AiClient, create };
}
const promptOf = (create: ReturnType<typeof provider>["create"]) => String(((create.mock.calls[0][0] as Anthropic.MessageCreateParamsNonStreaming).messages[0] as { content: string }).content);
const rows = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows;

describe("evidence selection (select_evidence_events)", () => {
  it("returns recent + first-seen + representative variants, each once, newest first, with reasons", async () => {
    // 30 events, 3 distinct shapes; the first-seen event is unique.
    const specs: Parameters<typeof buildEvent>[0][] = [{ message: "FIRST unique failure", occurred_at: ago(120 * MIN) }];
    for (let i = 0; i < 20; i++) specs.push({ message: `Cannot read items of cart ${i}`, occurred_at: ago((100 - i) * MIN), stack_trace: "TypeError\n    at addItem (/a.ts:1:1)" });
    for (let i = 0; i < 6; i++) specs.push({ message: `Promo ${i} invalid`, occurred_at: ago((60 - i) * MIN) });
    for (let i = 0; i < 3; i++) specs.push({ message: `Timeout after ${i}00ms`, occurred_at: ago((30 - i) * MIN) });
    const t = await incidentWith(specs);

    const picked = await fetchEvidenceEvents(t.db, t.incidentId);
    const ids = picked.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(picked.length).toBeLessThanOrEqual(11); // 6 recent + 1 first + 4 representative
    expect(picked.map((e) => e.occurredAt)).toEqual([...picked.map((e) => e.occurredAt)].sort().reverse()); // newest first

    const reasons = Object.fromEntries(picked.map((e) => [e.message, e.reason]));
    expect(reasons["FIRST unique failure"]).toBe("first_seen");
    expect(picked.filter((e) => e.reason === "recent")).toHaveLength(6);
    // Every distinct shape (digits normalised) is represented at least once.
    const shapes = new Set(picked.map((e) => e.message.replace(/\d+/g, "<n>")));
    expect([...shapes].sort()).toEqual(["Cannot read items of cart <n>", "FIRST unique failure", "Promo <n> invalid", "Timeout after <n>ms"].sort());
    // Full detail is included for the model.
    expect(picked.find((e) => e.message.startsWith("Cannot read"))?.stackTrace).toContain("addItem");
  });

  it("caps the selection even for huge incidents", async () => {
    const t = await incidentWith(Array.from({ length: 300 }, (_, i) => ({ message: `Failure variant ${i} ${"x".repeat(i % 50)}`, occurred_at: ago((400 - i) * 1000) })));
    const picked = await fetchEvidenceEvents(t.db, t.incidentId, { recent: 6, representative: 4 });
    expect(picked.length).toBeLessThanOrEqual(11);
    const wide = await fetchEvidenceEvents(t.db, t.incidentId, { recent: 100, representative: 100 });
    expect(wide.length).toBeLessThanOrEqual(41); // server-side maxima: 20 + 1 + 20
  });

  it("returns nothing for another user's incident", async () => {
    const owner = await incidentWith([{ message: "secret failure" }]);
    const other = await createUserAndProject(admin, "intruder");
    expect(await fetchEvidenceEvents(createPgRpc(admin, other.userId), owner.incidentId)).toEqual([]);
  });
});

describe("successful investigation: persistence", () => {
  it("stores status, model, usage, timestamps and the validated output, and returns it", async () => {
    const t = await incidentWith([{ message: "Cannot read items", occurred_at: ago(30 * MIN) }, { message: "Cannot read items", occurred_at: ago(20 * MIN) }, { message: "Cannot read items", occurred_at: ago(10 * MIN) }]);
    const { client, create } = provider(async () => message(goodReply(t.events)));

    const result = await investigateIncident(t.db, t.incidentId, { config: CONFIG, client });
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;

    const a = result.analysis;
    expect(a).toMatchObject({ status: "complete", summary: "The cart reads items before they are loaded.", model: "claude-sonnet-5-5", usage: { inputTokens: 1500, outputTokens: 700 }, retryable: false, errorMessage: null, completedSteps: [] });
    expect(a.inputEventCount).toBe(3);
    expect(a.hypotheses[0].evidence.map((e) => e.why)).toEqual(["event 0 shows it", "event 1 shows it"]);
    expect(a.hypotheses[0].confidence).toBe("medium");
    expect(a.recommendedSteps).toEqual([{ step: "Read addItem", rationale: "stack" }, { step: "Compare releases", rationale: null }, { step: "Check promo path", rationale: null }]);
    expect(a.missingInformation).toEqual(["Earlier events"]);
    expect(a.limitations).toEqual(["Selection of events only"]);
    expect(Date.parse(a.completedAt!)).toBeGreaterThanOrEqual(Date.parse(a.createdAt));

    // Verify what is actually in the table, not just what the API returned.
    const [row] = await rows("select status, model, completed_at, evidence_event_ids, input_event_count, usage from public.analyses where id = $1", [a.id]);
    expect(row.status).toBe("complete");
    expect(row.completed_at).not.toBeNull();
    expect(row.evidence_event_ids.sort()).toEqual(t.events.slice(0, 2).map((e) => e.id).sort());
    expect(row.usage).toEqual({ inputTokens: 1500, outputTokens: 700 });

    // ...and it is what the incident page will load next time ("last saved analysis").
    expect(await fetchLatestAnalysis(t.db, t.incidentId)).toMatchObject({ id: a.id, status: "complete" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("sends only this incident's stored evidence to the provider", async () => {
    const mine = await incidentWith([{ message: "Cart crash in my incident", attributes: { release: "9.9.9" } }]);
    // Another user's data must never appear in the prompt.
    await incidentWith([{ message: "OTHER USERS SECRET MESSAGE" }]);
    const { client, create } = provider(async () => message(goodReply(mine.events)));
    await investigateIncident(mine.db, mine.incidentId, { config: CONFIG, client });
    const prompt = promptOf(create);
    expect(prompt).toContain("Cart crash in my incident");
    expect(prompt).toContain("9.9.9");
    expect(prompt).toContain(mine.events[0].id);
    expect(prompt).not.toContain("OTHER USERS SECRET MESSAGE");
    expect(prompt).not.toContain(CONFIG.apiKey);
  });

  it("lets the same incident be re-run, keeping history and returning the newest", async () => {
    const t = await incidentWith([{ message: "Re-run me" }]);
    const first = await investigateIncident(t.db, t.incidentId, { config: CONFIG, client: provider(async () => message(goodReply(t.events, { summary: "First run." }))).client });
    const second = await investigateIncident(t.db, t.incidentId, { config: CONFIG, client: provider(async () => message(goodReply(t.events, { summary: "Second run." }))).client });
    expect(first.status).toBe("complete");
    expect(second.status).toBe("complete");
    expect((await rows("select count(*)::int n from public.analyses where incident_id = $1", [t.incidentId]))[0].n).toBe(2);
    expect((await fetchLatestAnalysis(t.db, t.incidentId))?.summary).toBe("Second run.");
  });
});

describe("verification and failure handling are persisted, never silent", () => {
  it("rejects an analysis citing an event that was not retrieved, saves a retryable failure, stores none of the content", async () => {
    const t = await incidentWith([{ message: "Real event" }]);
    const foreign = await incidentWith([{ message: "Event of another incident" }]);
    const bad = goodReply(t.events, { hypotheses: [{ title: "H", explanation: "e", confidence: "high", evidence: [{ event_id: t.events[0].id, why: "ok" }, { event_id: foreign.events[0].id, why: "borrowed from elsewhere" }] }] });
    const result = await investigateIncident(t.db, t.incidentId, { config: CONFIG, client: provider(async () => message(bad)).client });

    expect(result).toMatchObject({ status: "failed", code: "invalid_evidence", retryable: true });
    const [row] = await rows("select status, summary, hypotheses, evidence_event_ids, error_code, retryable from public.analyses where incident_id = $1", [t.incidentId]);
    expect(row).toMatchObject({ status: "failed", summary: null, error_code: "invalid_evidence", retryable: true, evidence_event_ids: [] });
    expect(row.hypotheses).toEqual([]);
  });

  it.each([
    ["not JSON", "I think it's the cart."],
    ["wrong schema", { summary: "x" }],
  ])("saves malformed output (%s) as a retryable failure", async (_n, body) => {
    const t = await incidentWith([{ message: "Malformed" }]);
    const result = await investigateIncident(t.db, t.incidentId, {
      config: CONFIG,
      client: provider(async () => ({ stop_reason: "end_turn", model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }] }) as unknown as Anthropic.Message).client,
    });
    expect(result).toMatchObject({ status: "failed", code: "invalid_response", retryable: true });
  });

  it.each([
    ["timeout", () => new Anthropic.APIConnectionTimeoutError(), "timeout", true],
    ["rate limit", () => new Anthropic.RateLimitError(429, undefined, "rl", new Headers()), "rate_limited", true],
    ["provider outage", () => new Anthropic.InternalServerError(529, undefined, "overloaded", new Headers()), "provider_unavailable", true],
    ["invalid key", () => new Anthropic.AuthenticationError(401, undefined, "bad key", new Headers()), "auth", false],
    ["unknown model", () => new Anthropic.NotFoundError(404, undefined, "no model", new Headers()), "model_unavailable", false],
  ])("a %s is saved as failed/%s and the analysis is NOT left pending", async (_n, make, code, retryable) => {
    const t = await incidentWith([{ message: `Provider failure ${code}` }]);
    const result = await investigateIncident(t.db, t.incidentId, { config: CONFIG, client: provider(async () => { throw make(); }).client });
    expect(result).toMatchObject({ status: "failed", code, retryable });
    expect((await rows("select count(*)::int n from public.analyses where incident_id = $1 and status = 'pending'", [t.incidentId]))[0].n).toBe(0);
    expect((await rows("select status, error_code, retryable, completed_at from public.analyses where incident_id = $1", [t.incidentId]))[0]).toMatchObject({ status: "failed", error_code: code, retryable });
    // A failed analysis never blocks the next attempt.
    const retry = await investigateIncident(t.db, t.incidentId, { config: CONFIG, client: provider(async () => message(goodReply(t.events))).client });
    expect(retry.status).toBe("complete");
  });

  it("does not expose provider text or the key in stored errors", async () => {
    const t = await incidentWith([{ message: "Leak check" }]);
    await investigateIncident(t.db, t.incidentId, { config: CONFIG, client: provider(async () => { throw new Anthropic.AuthenticationError(401, undefined, "invalid x-api-key sk-ant-test", new Headers()); }).client });
    const [row] = await rows("select error_message from public.analyses where incident_id = $1", [t.incidentId]);
    expect(row.error_message).not.toMatch(/sk-ant|x-api-key/);
  });
});

describe("never stuck, never duplicated", () => {
  it("runs exactly one provider call when many requests arrive at once; the rest are told one is in progress", async () => {
    const t = await incidentWith([{ message: "Race" }]);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { client, create } = provider(async () => {
      await gate;
      return message(goodReply(t.events));
    });
    const runs = Array.from({ length: 6 }, () => investigateIncident(createPgRpc(admin, t.userId), t.incidentId, { config: CONFIG, client }));
    // Give every request time to reach the database before the first provider call returns.
    await new Promise((r) => setTimeout(r, 300));
    release();
    const results = await Promise.all(runs);

    expect(create).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === "complete")).toHaveLength(1);
    expect(results.filter((r) => r.status === "in_progress")).toHaveLength(5);
    expect((await rows("select count(*)::int n from public.analyses where incident_id = $1", [t.incidentId]))[0].n).toBe(1);
  });

  it("reports a pending analysis older than 2 minutes as failed/retryable, so a killed request can't look stuck", async () => {
    const t = await incidentWith([{ message: "Stale" }]);
    const started = (await t.db.rpc("start_analysis", { p_incident: t.incidentId, p_model: "m" })).data as { id: string };
    expect((await fetchLatestAnalysis(t.db, t.incidentId))?.status).toBe("pending");

    await admin.query("update public.analyses set created_at = now() - interval '3 minutes' where id = $1", [started.id]);
    expect(await fetchLatestAnalysis(t.db, t.incidentId)).toMatchObject({ status: "failed", errorCode: "timeout", retryable: true });

    // ...and a new run is allowed, expiring the dead row in the database.
    const retry = await investigateIncident(t.db, t.incidentId, { config: CONFIG, client: provider(async () => message(goodReply(t.events))).client });
    expect(retry.status).toBe("complete");
    expect((await rows("select status, error_code from public.analyses where id = $1", [started.id]))[0]).toMatchObject({ status: "failed", error_code: "timeout" });
  });

  it("allows at most 20 analyses per user per hour (cost guard) without calling the provider", async () => {
    const t = await incidentWith([{ message: "Cost guard" }]);
    await admin.query(
      "insert into public.analyses (incident_id, status, completed_at) select $1, 'failed', now() from generate_series(1, 20)",
      [t.incidentId],
    );
    const { client, create } = provider(async () => message(goodReply(t.events)));
    expect(await investigateIncident(t.db, t.incidentId, { config: CONFIG, client })).toEqual({ status: "rate_limited" });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("authorization", () => {
  it("another user's incident is 'not found': no provider call, no analysis row, nothing leaked", async () => {
    const owner = await incidentWith([{ message: "Owner's private incident" }]);
    const intruder = await createUserAndProject(admin, "intruder");
    const { client, create } = provider(async () => message(goodReply(owner.events)));

    const result = await investigateIncident(createPgRpc(admin, intruder.userId), owner.incidentId, { config: CONFIG, client });
    expect(result).toEqual({ status: "not_found" });
    expect(create).not.toHaveBeenCalled();
    expect((await rows("select count(*)::int n from public.analyses where incident_id = $1", [owner.incidentId]))[0].n).toBe(0);
  });

  it("another user cannot read, finish, or tick steps of someone else's analysis", async () => {
    const owner = await incidentWith([{ message: "Owner analysis" }]);
    const done = await investigateIncident(owner.db, owner.incidentId, { config: CONFIG, client: provider(async () => message(goodReply(owner.events))).client });
    if (done.status !== "complete") throw new Error("setup failed");
    const intruder = createPgRpc(admin, (await createUserAndProject(admin, "intruder")).userId);

    expect(await fetchLatestAnalysis(intruder, owner.incidentId)).toBeNull();
    expect(await setAnalysisStep(intruder, { analysisId: done.analysis.id, index: 0, done: true })).toEqual({ result: "not_found" });
    expect((await intruder.rpc("get_latest_analysis", { p_incident: owner.incidentId })).data).toEqual([]);
    expect((await rows("select completed_steps from public.analyses where id = $1", [done.analysis.id]))[0].completed_steps).toEqual([]);
  });

  it("signed-out (anon) callers cannot use any analysis function", async () => {
    const anon = createPgRpc(admin, null);
    for (const [fn, args] of [
      ["start_analysis", { p_incident: "00000000-0000-4000-8000-000000000000", p_model: "m" }],
      ["get_latest_analysis", { p_incident: "00000000-0000-4000-8000-000000000000" }],
      ["set_analysis_step", { p_analysis: "00000000-0000-4000-8000-000000000000", p_index: 0, p_done: true }],
      ["select_evidence_events", { p_incident: "00000000-0000-4000-8000-000000000000", p_recent: 6, p_representative: 4 }],
    ] as const) {
      expect((await anon.rpc(fn, args)).error?.message, fn).toMatch(/permission denied/);
    }
  });
});

describe("recommended-step checklist persistence", () => {
  it("ticks and unticks steps, idempotently and in order, and survives reload", async () => {
    const t = await incidentWith([{ message: "Checklist" }]);
    const done = await investigateIncident(t.db, t.incidentId, { config: CONFIG, client: provider(async () => message(goodReply(t.events))).client });
    if (done.status !== "complete") throw new Error("setup failed");
    const id = done.analysis.id;

    expect(await setAnalysisStep(t.db, { analysisId: id, index: 2, done: true })).toEqual({ result: "ok", completedSteps: [2] });
    expect(await setAnalysisStep(t.db, { analysisId: id, index: 0, done: true })).toEqual({ result: "ok", completedSteps: [0, 2] });
    expect(await setAnalysisStep(t.db, { analysisId: id, index: 0, done: true })).toEqual({ result: "ok", completedSteps: [0, 2] }); // idempotent
    expect(await setAnalysisStep(t.db, { analysisId: id, index: 2, done: false })).toEqual({ result: "ok", completedSteps: [0] });
    expect((await fetchLatestAnalysis(t.db, t.incidentId))?.completedSteps).toEqual([0]);
  });

  it("rejects out-of-range indexes and non-complete analyses", async () => {
    const t = await incidentWith([{ message: "Bounds" }]);
    const done = await investigateIncident(t.db, t.incidentId, { config: CONFIG, client: provider(async () => message(goodReply(t.events))).client });
    if (done.status !== "complete") throw new Error("setup failed");
    expect(await setAnalysisStep(t.db, { analysisId: done.analysis.id, index: 3, done: true })).toEqual({ result: "invalid_input" }); // only 3 steps: 0..2
    expect(await setAnalysisStep(t.db, { analysisId: done.analysis.id, index: -1, done: true })).toEqual({ result: "invalid_input" });

    const failed = await incidentWith([{ message: "Failed analysis" }]);
    await investigateIncident(failed.db, failed.incidentId, { config: CONFIG, client: provider(async () => { throw new Anthropic.APIConnectionTimeoutError(); }).client });
    const row = (await rows("select id from public.analyses where incident_id = $1", [failed.incidentId]))[0];
    expect(await setAnalysisStep(failed.db, { analysisId: row.id, index: 0, done: true })).toEqual({ result: "not_found" });
  });
});

describe("POST /api/v1/incidents/[incidentId]/analyze end to end (real handler, real database)", () => {
  const request = (headers: Record<string, string> = {}) =>
    new Request("http://app.test/api/v1/incidents/x/analyze", { method: "POST", headers: { "content-type": "application/json", host: "app.test", ...headers }, body: "{}" });
  const deps = (userId: string | null, client?: AiClient, config: typeof CONFIG | null = CONFIG) => ({
    getUser: async () => (userId ? { id: userId, email_confirmed_at: "2026-01-01T00:00:00Z" } : null),
    getDb: async () => createPgRpc(admin, userId),
    getConfig: () => config,
    client,
  });

  it("returns 200 with the persisted analysis for the owner", async () => {
    const t = await incidentWith([{ message: "HTTP flow" }, { message: "HTTP flow" }]);
    const res = await handleAnalyze(request(), t.incidentId, deps(t.userId, provider(async () => message(goodReply(t.events))).client));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.analysis).toMatchObject({ status: "complete", summary: "The cart reads items before they are loaded." });
    expect((await rows("select status from public.analyses where id = $1", [body.analysis.id]))[0].status).toBe("complete");
  });

  it("returns 401 signed out, 404 for someone else's incident, and 404 for a malformed id", async () => {
    const t = await incidentWith([{ message: "HTTP auth" }]);
    const { client, create } = provider(async () => message(goodReply(t.events)));
    expect((await handleAnalyze(request(), t.incidentId, deps(null, client))).status).toBe(401);
    const intruder = (await createUserAndProject(admin, "intruder")).userId;
    expect((await handleAnalyze(request(), t.incidentId, deps(intruder, client))).status).toBe(404);
    expect((await handleAnalyze(request(), "not-a-uuid", deps(t.userId, client))).status).toBe(404);
    expect(create).not.toHaveBeenCalled();
  });

  it("returns 503 with a clear message when credentials are missing, and creates no analysis", async () => {
    const t = await incidentWith([{ message: "No creds" }]);
    const res = await handleAnalyze(request(), t.incidentId, deps(t.userId, undefined, null));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatchObject({ code: "ai_not_configured", message: expect.stringContaining("ANTHROPIC_API_KEY") });
    expect((await rows("select count(*)::int n from public.analyses where incident_id = $1", [t.incidentId]))[0].n).toBe(0);
  });

  it("maps a provider timeout to 504 with the saved failed analysis, and a concurrent duplicate to 409", async () => {
    const t = await incidentWith([{ message: "HTTP failure" }]);
    const timedOut = await handleAnalyze(request(), t.incidentId, deps(t.userId, provider(async () => { throw new Anthropic.APIConnectionTimeoutError(); }).client));
    expect(timedOut.status).toBe(504);
    const body = await timedOut.json();
    expect(body.error).toMatchObject({ code: "timeout", retryable: true });
    expect(body.analysis).toMatchObject({ status: "failed", errorCode: "timeout" });

    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slow = handleAnalyze(request(), t.incidentId, deps(t.userId, provider(async () => { await gate; return message(goodReply(t.events)); }).client));
    await new Promise((r) => setTimeout(r, 300));
    const duplicate = await handleAnalyze(request(), t.incidentId, deps(t.userId, provider(async () => message(goodReply(t.events))).client));
    expect(duplicate.status).toBe(409);
    release();
    expect((await slow).status).toBe(200);
  });
});
