import { describe, expect, it } from "vitest";
import { recordingSupabase } from "../../../tests/helpers/recording-supabase";
import { MAX_ACTIVE_KEYS_PER_PROJECT, createApiKey, listApiKeys, revokeApiKey } from "./key-service";
import { hashApiKey } from "./keys";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const record = { id: "22222222-2222-4222-8222-222222222222", project_id: PROJECT, name: "prod", key_prefix: "tp_live_abcd", created_at: "2026-10-29T00:00:00Z", last_used_at: null, revoked_at: null };

describe("createApiKey", () => {
  it("returns the plaintext once and persists only its hash and prefix", async () => {
    const db = recordingSupabase({ "api_keys.select": { count: 0 }, "api_keys.insert": { data: record } });
    const result = await createApiKey(db.client, { projectId: PROJECT, name: "  prod  " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.key).toMatch(/^tp_live_[A-Za-z0-9_-]{43}$/);
    const [inserted] = db.find("api_keys", "insert")[0].args as [Record<string, string>];
    expect(inserted).toEqual({
      project_id: PROJECT,
      name: "prod",
      key_prefix: result.key.slice(0, 12),
      key_hash: hashApiKey(result.key),
    });
    // The plaintext must not appear anywhere in what was sent to the database.
    expect(JSON.stringify(db.calls)).not.toContain(result.key);
    // And the returned record exposes no hash.
    expect(JSON.stringify(result.record)).not.toContain("key_hash");
  });

  it("selects only non-secret columns when reading back the new key", async () => {
    const db = recordingSupabase({ "api_keys.select": { count: 0 }, "api_keys.insert": { data: record } });
    await createApiKey(db.client, { projectId: PROJECT, name: "prod" });
    const selects = db.calls.filter((c) => c.method.endsWith(".select")).flatMap((c) => c.args.map(String));
    expect(selects.join(" ")).not.toContain("key_hash");
  });

  it("generates a different key every time", async () => {
    const db = recordingSupabase({ "api_keys.select": { count: 0 }, "api_keys.insert": { data: record } });
    const a = await createApiKey(db.client, { projectId: PROJECT, name: "a" });
    const b = await createApiKey(db.client, { projectId: PROJECT, name: "b" });
    expect(a.ok && b.ok && a.key !== b.key).toBe(true);
  });

  it.each([
    ["blank name", { projectId: PROJECT, name: "   " }],
    ["long name", { projectId: PROJECT, name: "n".repeat(81) }],
    ["bad project id", { projectId: "../etc", name: "x" }],
    ["missing input", null],
  ])("rejects %s without touching the database", async (_l, input) => {
    const db = recordingSupabase({});
    const result = await createApiKey(db.client, input);
    expect(result.ok).toBe(false);
    expect(db.calls).toHaveLength(0);
  });

  it("enforces the per-project active key limit", async () => {
    const db = recordingSupabase({ "api_keys.select": { count: MAX_ACTIVE_KEYS_PER_PROJECT } });
    const result = await createApiKey(db.client, { projectId: PROJECT, name: "one too many" });
    expect(!result.ok && result.message).toMatch(/at most 10 active keys/);
    expect(db.find("api_keys", "insert")).toHaveLength(0);
  });

  it("reports 'Project not found' when row level security rejects the insert (not your project)", async () => {
    const db = recordingSupabase({
      "api_keys.select": { count: 0 },
      "api_keys.insert": { data: null, error: { code: "42501", message: "new row violates row-level security policy" } },
    });
    const result = await createApiKey(db.client, { projectId: PROJECT, name: "x" });
    expect(!result.ok && result.message).toBe("Project not found.");
  });

  it("returns a generic message on other database errors, never the raw error", async () => {
    const db = recordingSupabase({
      "api_keys.select": { count: 0 },
      "api_keys.insert": { data: null, error: { code: "XX000", message: "internal pg detail" } },
    });
    const result = await createApiKey(db.client, { projectId: PROJECT, name: "x" });
    expect(!result.ok && result.message).not.toContain("internal pg detail");
  });
});

describe("revokeApiKey", () => {
  it("revokes an active key", async () => {
    const db = recordingSupabase({ "api_keys.update": { data: [{ id: record.id }] } });
    const result = await revokeApiKey(db.client, record.id);
    expect(result.ok).toBe(true);
    expect(db.find("api_keys", "update.is")[0].args).toEqual(["revoked_at", null]);
  });

  it("reports not found / already revoked when nothing was updated (also covers other users' keys under RLS)", async () => {
    const db = recordingSupabase({ "api_keys.update": { data: [] } });
    const result = await revokeApiKey(db.client, record.id);
    expect(!result.ok && result.message).toMatch(/not found or already revoked/);
  });

  it("rejects a malformed id without a database call", async () => {
    const db = recordingSupabase({});
    expect((await revokeApiKey(db.client, "not-a-uuid")).ok).toBe(false);
    expect(db.calls).toHaveLength(0);
  });
});

describe("listApiKeys", () => {
  it("returns records for the project", async () => {
    const db = recordingSupabase({ "api_keys.select": { data: [record] } });
    expect(await listApiKeys(db.client, PROJECT)).toEqual([record]);
  });
});
