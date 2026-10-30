import type { Metadata } from "next";
import { DatabaseSetupRequired } from "@/components/layout/database-setup";
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard";
import { getPublicEnv } from "@/lib/env";
import { ingestUrl } from "@/lib/ingest-snippets";
import { listApiKeys } from "@/lib/ingest/key-service";
import { listProjects } from "@/lib/projects/service";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Get started" };

export default async function OnboardingPage() {
  const result = await listProjects(await createClient());
  if (!result.ok) {
    if (result.reason === "schema_missing") return <DatabaseSetupRequired />;
    throw new Error(result.message);
  }

  const siteUrl = getPublicEnv()?.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  // A returning user resumes at the install step with their newest project; no duplicate is made.
  const project = result.projects[0] ?? null;
  const keys = project ? await listApiKeys(await createClient(), project.id) : [];
  return <OnboardingWizard initialProject={project} initialKeys={keys} endpoint={ingestUrl(siteUrl)} />;
}
