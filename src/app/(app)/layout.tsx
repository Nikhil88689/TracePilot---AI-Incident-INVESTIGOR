import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { ConfigRequired } from "@/components/layout/config-required";
import { DatabaseSetupRequired } from "@/components/layout/database-setup";
import { requireUser } from "@/lib/auth/session";
import { isSupabaseConfigured } from "@/lib/env";
import { DataError, asRpc, fetchUnresolvedByProject } from "@/lib/incidents/queries";
import { WORKSPACE_LABEL } from "@/lib/incidents/scope";
import { listProjects } from "@/lib/projects/service";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Postgres/PostgREST codes for "function or table does not exist": a migration has not been applied. */
const SCHEMA_MISSING = new Set(["42883", "42P01", "42703", "PGRST202", "PGRST205"]);

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (!isSupabaseConfigured()) return <ConfigRequired />;

  // Defense in depth: the proxy already gates these routes, but never trust a single layer.
  const user = await requireUser();

  const supabase = await createClient();
  const owned = await listProjects(supabase);
  if (!owned.ok) {
    if (owned.reason === "schema_missing") return <DatabaseSetupRequired />;
    throw new Error(owned.message);
  }
  // First-time users have no project yet and go through onboarding.
  if (owned.projects.length === 0) redirect("/onboarding");

  let unresolvedByProject: Record<string, number>;
  try {
    unresolvedByProject = await fetchUnresolvedByProject(asRpc(supabase));
  } catch (error) {
    if (error instanceof DataError && error.code && SCHEMA_MISSING.has(error.code)) return <DatabaseSetupRequired />;
    throw error;
  }

  const projects = [...owned.projects]
    .reverse()
    .map((p) => ({ id: p.id, name: p.name, workspace: WORKSPACE_LABEL, environment: p.environment, isDemo: p.is_demo ?? false }));

  return (
    <AppShell projects={projects} unresolvedByProject={unresolvedByProject} userEmail={user.email ?? "Signed in"}>
      {children}
    </AppShell>
  );
}
