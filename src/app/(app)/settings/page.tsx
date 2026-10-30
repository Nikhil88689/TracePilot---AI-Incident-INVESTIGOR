import type { Metadata } from "next";
import { FolderKanban } from "lucide-react";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { ApiKeyManager } from "@/components/ingest/api-key-manager";
import { CopyButton } from "@/components/common/copy-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getPublicEnv } from "@/lib/env";
import { ingestUrl } from "@/lib/ingest-snippets";
import { listApiKeys } from "@/lib/ingest/key-service";
import { listProjects } from "@/lib/projects/service";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Project Settings" };

export default async function SettingsPage() {
  const supabase = await createClient();
  const result = await listProjects(supabase);
  if (!result.ok) throw new Error(result.message);

  const endpoint = ingestUrl(getPublicEnv()?.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000");
  const projects = await Promise.all(
    result.projects.map(async (project) => ({ project, keys: await listApiKeys(supabase, project.id) })),
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Project Settings" description="Your projects and the API keys applications use to send events." />

      {projects.length === 0 ? (
        <Card>
          <EmptyState icon={FolderKanban} title="No projects yet" description="Create a project from onboarding to manage its keys." />
        </Card>
      ) : (
        projects.map(({ project, keys }) => (
          <Card key={project.id}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <span className="font-mono">{project.name}</span>
                <Badge variant="outline">{project.environment}</Badge>
              </CardTitle>
              <CardDescription>Ingestion endpoint for this project&apos;s applications.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs">
                  {endpoint}
                </code>
                <CopyButton value={endpoint} />
              </div>
              <div>
                <h2 className="mb-2 text-sm font-medium">API keys</h2>
                <ApiKeyManager projectId={project.id} initialKeys={keys} />
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
