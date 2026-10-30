import type { Metadata } from "next";
import Link from "next/link";
import { ChartNoAxesColumn, Inbox, ShieldCheck } from "lucide-react";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { ChartCard } from "@/components/dashboard/chart-card";
import { DashboardActions } from "@/components/dashboard/dashboard-actions";
import { ErrorRateChart } from "@/components/dashboard/error-rate-chart";
import { KpiGrid } from "@/components/dashboard/kpi-grid";
import { MetricDefinitions } from "@/components/dashboard/metric-definitions";
import { ProjectHealthBar } from "@/components/dashboard/project-health-bar";
import { SectionError } from "@/components/dashboard/section-error";
import { SeverityChart } from "@/components/dashboard/severity-chart";
import { DemoCallout } from "@/components/demo/demo-callout";
import { TryDemoButton } from "@/components/demo/try-demo-button";
import { IncidentTable } from "@/components/incidents/incident-table";
import { SendTestEventButton } from "@/components/layout/send-test-event-button";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { deriveHealth } from "@/lib/dashboard/health";
import { RANGE_LABELS, parseRange } from "@/lib/dashboard/params";
import { DEFAULT_INCIDENT_PARAMS, parseUuid } from "@/lib/incidents/params";
import { asRpc, fetchDashboardOverview, fetchIncidentList } from "@/lib/incidents/queries";
import { resolveProjectScope } from "@/lib/incidents/scope";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

type Section<T> = { ok: true; data: T } | { ok: false };

/**
 * Runs one section's query and turns a failure into a value. Each section renders from its own result,
 * so a failing query degrades only that section (with a retry) instead of taking down the page.
 */
async function settle<T>(name: string, work: Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await work };
  } catch (error) {
    console.error(`[dashboard] ${name} failed:`, error instanceof Error ? error.message : "unknown error");
    return { ok: false };
  }
}

export default async function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  const raw = await searchParams;
  const range = parseRange(first(raw.range));

  const supabase = await createClient();
  const { project } = await resolveProjectScope(supabase, parseUuid(first(raw.project)));
  const db = asRpc(supabase);
  const now = new Date();

  // Independent sections: the overview feeds the health bar, KPIs and both charts; the table has its own query.
  const [overview, recent] = await Promise.all([
    settle("overview", fetchDashboardOverview(db, { project, range }, now)),
    settle("recent incidents", fetchIncidentList(db, { ...DEFAULT_INCIDENT_PARAMS, project: project?.id ?? null }, now)),
  ]);

  const projectQuery = project ? `?project=${project.id}` : "";
  const totalEvents = overview.ok ? (overview.data.kpis.find((k) => k.id === "events")?.value ?? 0) : 0;
  const unresolvedTotal = overview.ok ? overview.data.severityBreakdown.reduce((sum, s) => sum + s.count, 0) : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Project overview"
        description="Monitor errors, investigate incidents, and keep your applications healthy."
        actions={<DashboardActions />}
      />

      <DemoCallout step="dashboard" incidentsHref={`/incidents${project ? `?project=${project.id}&` : "?"}status=unresolved`} />

      {overview.ok ? (
        <ProjectHealthBar
          health={deriveHealth({ kpis: overview.data.kpis, series: overview.data.series, criticalUnresolved: overview.data.counts.critical })}
          projectName={project?.name ?? "All projects"}
          generatedAt={overview.data.generatedAt}
        />
      ) : (
        <Card className="p-0" aria-label="Project health">
          <SectionError title="Project health" className="py-4" />
        </Card>
      )}

      {overview.ok ? (
        <>
          <KpiGrid kpis={overview.data.kpis} range={range} projectId={project?.id ?? null} />
          <MetricDefinitions />
        </>
      ) : (
        <Card className="p-0" aria-label="Key metrics">
          <SectionError title="Key metrics" />
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <ChartCard
          className="lg:col-span-2"
          title="Error rate"
          description={`Errors as a share of all events, last ${RANGE_LABELS[range]} (UTC).`}
          empty={
            !overview.ok ? (
              <SectionError title="The error-rate chart" className="h-64" />
            ) : totalEvents > 0 ? undefined : (
              <EmptyState
                icon={ChartNoAxesColumn}
                title="No events in this time range"
                description="Send an event, pick a longer range, or explore the simulated demo."
                action={
                  <span className="flex flex-wrap justify-center gap-2">
                    <SendTestEventButton variant="outline" />
                    <TryDemoButton />
                  </span>
                }
                className="h-64"
              />
            )
          }
        >
          {overview.ok ? (
            <ErrorRateChart
              data={overview.data.series}
              range={range}
              deployments={overview.data.deployments.map((d) => ({ id: d.id, version: d.version, deployedAt: d.deployedAt, description: d.description }))}
            />
          ) : null}
        </ChartCard>

        <ChartCard
          title="Severity distribution"
          heightClass="h-auto sm:h-64"
          description="Unresolved incidents by severity."
          empty={
            !overview.ok ? (
              <SectionError title="The severity chart" className="h-64" />
            ) : unresolvedTotal > 0 ? undefined : (
              <EmptyState icon={ShieldCheck} title="No unresolved incidents" description="Nothing unresolved was seen in this range." className="h-64" />
            )
          }
        >
          {overview.ok ? <SeverityChart data={overview.data.severityBreakdown} /> : null}
        </ChartCard>
      </div>

      <section aria-labelledby="recent-incidents">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="recent-incidents" className="text-sm font-medium">
            Recent incidents
          </h2>
          <Link href={`/incidents${projectQuery}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
            View all
          </Link>
        </div>
        <Card className="gap-0 p-0">
          {!recent.ok ? (
            <SectionError title="Recent incidents" />
          ) : recent.data.total === 0 ? (
            <EmptyState
              icon={Inbox}
              title="No incidents yet"
              description="Incidents appear when your application sends error events."
              action={
                <span className="flex flex-wrap justify-center gap-2">
                  <SendTestEventButton />
                  <TryDemoButton />
                </span>
              }
            />
          ) : (
            <IncidentTable items={recent.data.items.slice(0, 6)} now={now.toISOString()} detailQuery={projectQuery} />
          )}
        </Card>
      </section>
    </div>
  );
}
