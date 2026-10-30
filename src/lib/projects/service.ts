import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreateProjectInput, Project } from "./schemas";

const COLUMNS = "id, name, environment, created_at, is_demo";
const UNIQUE_VIOLATION = "23505";
/** Postgres / PostgREST codes for "the table does not exist" (migration not applied). */
const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205", "42703"]);

export type CreateProjectResult =
  | { ok: true; project: Project; created: boolean }
  | { ok: false; reason: "duplicate_name" | "failed"; message: string };

export type ListProjectsResult =
  | { ok: true; projects: Project[] }
  | { ok: false; reason: "schema_missing" | "failed"; message: string };

/**
 * Creates a project owned by `ownerId`. Safe to retry: the same requestId always resolves to
 * the same row. Ownership is also enforced in Postgres by RLS, not just here.
 */
export async function createProject(
  supabase: SupabaseClient,
  ownerId: string,
  input: CreateProjectInput,
): Promise<CreateProjectResult> {
  const existing = await findByRequestId(supabase, input.requestId);
  if (existing.error) return failed();
  if (existing.project) return { ok: true, project: existing.project, created: false };

  const { data, error } = await supabase
    .from("projects")
    .insert({
      owner_id: ownerId,
      name: input.name,
      environment: input.environment,
      idempotency_key: input.requestId,
    })
    .select(COLUMNS)
    .single();

  if (!error && data) return { ok: true, project: data as Project, created: true };

  if (error?.code === UNIQUE_VIOLATION) {
    if (error.message.includes("projects_owner_name_uniq")) {
      return { ok: false, reason: "duplicate_name", message: "You already have a project with that name." };
    }
    // Lost a race with a concurrent retry of the same request: return the winner's row.
    const winner = await findByRequestId(supabase, input.requestId);
    if (winner.project) return { ok: true, project: winner.project, created: false };
  }
  return failed();
}

async function findByRequestId(supabase: SupabaseClient, requestId: string) {
  const { data, error } = await supabase
    .from("projects")
    .select(COLUMNS)
    .eq("idempotency_key", requestId)
    .maybeSingle();
  return { project: (data as Project | null) ?? null, error };
}

function failed(): CreateProjectResult {
  return { ok: false, reason: "failed", message: "We could not create the project. Please try again." };
}

/** Lists the caller's projects (RLS scopes the query to the signed-in user), newest first. */
export async function listProjects(supabase: SupabaseClient): Promise<ListProjectsResult> {
  const { data, error } = await supabase
    .from("projects")
    .select(COLUMNS)
    .order("created_at", { ascending: false });

  if (error) {
    if (error.code && MISSING_TABLE_CODES.has(error.code)) {
      return { ok: false, reason: "schema_missing", message: "The projects table does not exist yet." };
    }
    return { ok: false, reason: "failed", message: "Could not load projects." };
  }
  return { ok: true, projects: (data ?? []) as Project[] };
}
