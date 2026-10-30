import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Project } from "@/lib/dashboard/types";
import { listProjects } from "@/lib/projects/service";

export const WORKSPACE_LABEL = "Your projects";

/** The signed-in user's projects as the shell models them (RLS guarantees they are the caller's own). */
export async function loadShellProjects(supabase: SupabaseClient): Promise<Project[]> {
  const result = await listProjects(supabase);
  if (!result.ok) throw new Error(result.message);
  return [...result.projects]
    .reverse()
    .map((p) => ({ id: p.id, name: p.name, workspace: WORKSPACE_LABEL, environment: p.environment, isDemo: p.is_demo ?? false }));
}

/**
 * Resolves the `?project=` URL value. Anything that is not one of the caller's own projects
 * (junk, someone else's id) falls back to "all projects", so a tampered URL cannot widen or
 * redirect a query.
 */
export async function resolveProjectScope(supabase: SupabaseClient, requested: string | null) {
  const projects = await loadShellProjects(supabase);
  return { projects, project: projects.find((p) => p.id === requested) ?? null };
}
