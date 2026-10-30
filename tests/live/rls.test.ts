/**
 * Row Level Security integration test against a REAL Supabase project.
 *
 * Opt-in: run with `npm run test:rls`. It needs NEXT_PUBLIC_SUPABASE_URL,
 * NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or legacy ANON_KEY) and SUPABASE_SERVICE_ROLE_KEY (loaded from .env.local), and
 * both migrations applied. It creates two throwaway confirmed users and deletes them (and,
 * by cascade, their projects) afterwards. Never point it at a database with data you care about.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(url && anonKey && serviceKey);

const run = Date.now();
const password = `Rls-${run}-pw1`;
const emails = { a: `tp-rls-a-${run}@example.com`, b: `tp-rls-b-${run}@example.com` };

describe.skipIf(!configured)("projects RLS (real database)", () => {
  let admin: SupabaseClient;
  let a: SupabaseClient;
  let b: SupabaseClient;
  let anon: SupabaseClient;
  const ids: { a?: string; b?: string; project?: string } = {};
  const fresh = () => createClient(url!, anonKey!, { auth: { persistSession: false, autoRefreshToken: false } });

  async function signedInClient(email: string) {
    const client = fresh();
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return client;
  }

  beforeAll(async () => {
    admin = createClient(url!, serviceKey!, { auth: { persistSession: false, autoRefreshToken: false } });

    // Fail fast (before creating any users): without the schema every negative test would pass vacuously.
    const probe = await admin.from("projects").select("id, environment, idempotency_key").limit(1);
    if (probe.error) {
      throw new Error(
        `projects schema not ready (${probe.error.code}). Apply both files in supabase/migrations/ first.`,
      );
    }
    for (const key of ["a", "b"] as const) {
      const { data, error } = await admin.auth.admin.createUser({
        email: emails[key],
        password,
        email_confirm: true,
      });
      if (error) throw error;
      ids[key] = data.user.id;
    }
    a = await signedInClient(emails.a);
    b = await signedInClient(emails.b);
    anon = fresh();
  });

  afterAll(async () => {
    if (!admin) return;
    for (const key of ["a", "b"] as const) if (ids[key]) await admin.auth.admin.deleteUser(ids[key]!);
  });

  it("lets an owner create and read their project", async () => {
    const { data, error } = await a
      .from("projects")
      .insert({ owner_id: ids.a, name: "rls-project", environment: "staging", idempotency_key: crypto.randomUUID() })
      .select("id, name")
      .single();
    expect(error).toBeNull();
    ids.project = data!.id;
    const { data: list } = await a.from("projects").select("id");
    expect(list?.map((p) => p.id)).toContain(ids.project);
  });

  it("hides another user's project from reads", async () => {
    const { data, error } = await b.from("projects").select("id").eq("id", ids.project!);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("does not let another user update or delete it", async () => {
    const updated = await b.from("projects").update({ name: "hijacked" }).eq("id", ids.project!).select();
    expect(updated.data ?? []).toEqual([]);
    const deleted = await b.from("projects").delete().eq("id", ids.project!).select();
    expect(deleted.data ?? []).toEqual([]);

    const { data } = await a.from("projects").select("name").eq("id", ids.project!).single();
    expect(data?.name).toBe("rls-project");
  });

  it("does not let a user create a project owned by someone else", async () => {
    const { error } = await b.from("projects").insert({ owner_id: ids.a, name: "forged", environment: "production" });
    expect(error).not.toBeNull();
  });

  it("does not let an owner hand a project to another user", async () => {
    const { error } = await a.from("projects").update({ owner_id: ids.b }).eq("id", ids.project!);
    expect(error).not.toBeNull();
  });

  it("gives signed-out (anon) requests no access", async () => {
    const { data, error } = await anon.from("projects").select("id");
    expect(error !== null || (data ?? []).length === 0).toBe(true);
    const insert = await anon.from("projects").insert({ owner_id: ids.a, name: "anon", environment: "production" });
    expect(insert.error).not.toBeNull();
  });

  it("enforces idempotency keys and per-owner unique names", async () => {
    const key = crypto.randomUUID();
    const first = await a.from("projects").insert({ owner_id: ids.a, name: "idem-1", idempotency_key: key });
    expect(first.error).toBeNull();
    const retry = await a.from("projects").insert({ owner_id: ids.a, name: "idem-2", idempotency_key: key });
    expect(retry.error?.code).toBe("23505");

    const dup = await a.from("projects").insert({ owner_id: ids.a, name: "IDEM-1" });
    expect(dup.error?.code).toBe("23505");

    // Another owner may reuse the same name and key.
    const other = await b.from("projects").insert({ owner_id: ids.b, name: "idem-1", idempotency_key: key });
    expect(other.error).toBeNull();
  });

  it("rejects an invalid environment at the database level", async () => {
    const { error } = await a.from("projects").insert({ owner_id: ids.a, name: "bad-env", environment: "prod" });
    expect(error).not.toBeNull();
  });
});
