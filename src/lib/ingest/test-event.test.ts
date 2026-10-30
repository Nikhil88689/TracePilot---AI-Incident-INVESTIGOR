import { describe, expect, it, vi } from "vitest";
import { recordingSupabase } from "../../../tests/helpers/recording-supabase";
import { buildTestEvent, sendTestEvent } from "./test-event";
import { parseIngestBody } from "./schemas";
import { hashApiKey } from "./keys";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const SITE = "https://app.example.com";

const happyDb = (over: Record<string, object> = {}) =>
  recordingSupabase({
    "projects.select": { data: { id: PROJECT, environment: "staging" } },
    "api_keys.insert": { data: { id: "key-1" } },
    "api_keys.update": { data: null },
    ...over,
  });

const okResponse = () =>
  new Response(JSON.stringify({ accepted: 1, duplicates: 0, results: [{ incident_id: "inc-1", occurrence_count: 4 }] }), { status: 201 });

describe("buildTestEvent", () => {
  it("builds an event the ingestion API accepts, with a unique id each time", () => {
    const a = buildTestEvent({ environment: "staging" });
    const b = buildTestEvent({ environment: "staging" });
    expect(a.external_event_id).not.toBe(b.external_event_id);
    expect(parseIngestBody(a, new Date()).ok).toBe(true);
  });
});

describe("sendTestEvent", () => {
  it("goes through the real ingestion endpoint with a bearer key, then reports the incident", async () => {
    const db = happyDb();
    const fetchImpl = vi.fn(async () => okResponse());
    const result = await sendTestEvent(PROJECT, { supabase: db.client, siteUrl: SITE, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result).toEqual({ ok: true, created: true, incidentId: "inc-1", occurrenceCount: 4 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${SITE}/api/v1/events`);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toMatch(/^Bearer tp_live_[A-Za-z0-9_-]{43}$/);

    // The key sent over HTTP matches the hash that was stored; the plaintext was never stored.
    const [inserted] = db.find("api_keys", "insert")[0].args as [{ key_hash: string }];
    expect(inserted.key_hash).toBe(hashApiKey(auth.replace("Bearer ", "")));
    expect(JSON.stringify(db.calls)).not.toContain(auth.replace("Bearer ", ""));
  });

  it("never writes events or incidents to the database directly", async () => {
    const db = happyDb();
    await sendTestEvent(PROJECT, { supabase: db.client, siteUrl: SITE, fetchImpl: (async () => okResponse()) as unknown as typeof fetch });
    const tables = new Set(db.calls.map((c) => c.table));
    expect([...tables].sort()).toEqual(["api_keys", "projects"]);
  });

  it("revokes the temporary key afterwards, even when the request fails", async () => {
    const db = happyDb();
    const result = await sendTestEvent(PROJECT, {
      supabase: db.client,
      siteUrl: SITE,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    const updates = db.find("api_keys", "update");
    expect(updates).toHaveLength(1);
    expect((updates[0].args[0] as { revoked_at: string }).revoked_at).toBeTruthy();
    expect(db.find("api_keys", "update.eq")[0].args).toEqual(["id", "key-1"]);
  });

  it("retries revocation once if the first attempt fails", async () => {
    const db = happyDb({ "api_keys.update": [{ error: { message: "blip" } }, { error: null }] as never });
    await sendTestEvent(PROJECT, { supabase: db.client, siteUrl: SITE, fetchImpl: (async () => okResponse()) as unknown as typeof fetch });
    expect(db.find("api_keys", "update")).toHaveLength(2);
  });

  it("refuses a project the caller cannot see (row level security) and mints no key", async () => {
    const db = happyDb({ "projects.select": { data: null } });
    const fetchImpl = vi.fn();
    const result = await sendTestEvent(PROJECT, { supabase: db.client, siteUrl: SITE, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ ok: false, message: "Project not found." });
    expect(db.find("api_keys", "insert")).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an invalid project id without any database call", async () => {
    const db = happyDb();
    expect((await sendTestEvent("../x", { supabase: db.client, siteUrl: SITE })).ok).toBe(false);
    expect(db.calls).toHaveLength(0);
  });

  it("surfaces the API's own error message (e.g. rate limiting) and never leaks the key", async () => {
    const db = happyDb();
    const result = await sendTestEvent(PROJECT, {
      supabase: db.client,
      siteUrl: SITE,
      fetchImpl: (async () => new Response(JSON.stringify({ error: { message: "Rate limit exceeded. Retry later." } }), { status: 429 })) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, message: "Rate limit exceeded. Retry later." });
  });

  it("times out instead of hanging", async () => {
    const db = happyDb();
    const result = await sendTestEvent(PROJECT, {
      supabase: db.client,
      siteUrl: SITE,
      timeoutMs: 50,
      fetchImpl: ((_u: unknown, init: RequestInit) =>
        new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as unknown as typeof fetch,
    });
    expect(!result.ok && result.message).toMatch(/did not respond in time/);
  });

  it("fails cleanly if the key cannot be minted", async () => {
    const db = happyDb({ "api_keys.insert": { data: null, error: { message: "rls" } } });
    const result = await sendTestEvent(PROJECT, { supabase: db.client, siteUrl: SITE });
    expect(result.ok).toBe(false);
    expect(db.find("api_keys", "update")).toHaveLength(0);
  });
});
