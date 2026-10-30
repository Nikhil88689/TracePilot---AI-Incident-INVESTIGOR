import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { generateApiKey } from "./keys";

export const MAX_ACTIVE_KEYS_PER_PROJECT = 10;

/** Columns a signed-in user may read. The hash column is not selectable by them (see migration). */
const COLUMNS = "id, project_id, name, key_prefix, created_at, last_used_at, revoked_at";

export type ApiKeyRecord = {
  id: string;
  project_id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

export const createApiKeySchema = z.object({
  projectId: z.uuid("Invalid project."),
  name: z.string().trim().min(1, "Enter a name for this key.").max(80, "Names can be at most 80 characters."),
});

export type CreateApiKeyResult =
  | { ok: true; key: string; record: ApiKeyRecord }
  | { ok: false; message: string; fieldErrors?: { name?: string } };

/**
 * Mints a key for a project the caller owns. Ownership is enforced by Postgres (RLS), so an
 * attempt against someone else's project fails at the database even if this code were wrong.
 * The plaintext is returned to the caller exactly once and never persisted.
 */
export async function createApiKey(supabase: SupabaseClient, raw: unknown): Promise<CreateApiKeyResult> {
  const parsed = createApiKeySchema.safeParse(raw);
  if (!parsed.success) {
    const nameIssue = parsed.error.issues.find((i) => i.path[0] === "name");
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid input.", fieldErrors: nameIssue ? { name: nameIssue.message } : undefined };
  }
  const { projectId, name } = parsed.data;

  const active = await supabase
    .from("api_keys")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .is("revoked_at", null);
  if (active.error) return { ok: false, message: "Could not create the key. Please try again." };
  if ((active.count ?? 0) >= MAX_ACTIVE_KEYS_PER_PROJECT) {
    return { ok: false, message: `A project can have at most ${MAX_ACTIVE_KEYS_PER_PROJECT} active keys. Revoke one first.` };
  }

  const generated = generateApiKey();
  const { data, error } = await supabase
    .from("api_keys")
    .insert({ project_id: projectId, name, key_prefix: generated.prefix, key_hash: generated.hash })
    .select(COLUMNS)
    .single();

  if (error || !data) {
    // 42501 = row-level security rejected the insert: not the caller's project.
    return { ok: false, message: error?.code === "42501" ? "Project not found." : "Could not create the key. Please try again." };
  }
  return { ok: true, key: generated.key, record: data as ApiKeyRecord };
}

export type RevokeResult = { ok: true; revokedAt: string } | { ok: false; message: string };

export async function revokeApiKey(supabase: SupabaseClient, keyId: string): Promise<RevokeResult> {
  if (!z.uuid().safeParse(keyId).success) return { ok: false, message: "Invalid key." };
  const revokedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from("api_keys")
    .update({ revoked_at: revokedAt })
    .eq("id", keyId)
    .is("revoked_at", null)
    .select("id");
  if (error) return { ok: false, message: "Could not revoke the key. Please try again." };
  // RLS hides other users' keys, so "nothing updated" covers both "not yours" and "already revoked".
  if (!data || data.length === 0) return { ok: false, message: "Key not found or already revoked." };
  return { ok: true, revokedAt };
}

export async function listApiKeys(supabase: SupabaseClient, projectId: string): Promise<ApiKeyRecord[]> {
  const { data } = await supabase
    .from("api_keys")
    .select(COLUMNS)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  return (data ?? []) as ApiKeyRecord[];
}
