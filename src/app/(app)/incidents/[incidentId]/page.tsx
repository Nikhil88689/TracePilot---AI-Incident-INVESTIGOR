import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Calendar, Clock, Route } from "lucide-react";
import { Pagination } from "@/components/common/pagination";
import { SeverityBadge, StatusBadge } from "@/components/dashboard/status-badges";
import { ChartCard } from "@/components/dashboard/chart-card";
import { EventRow } from "@/components/events/event-row";
import { DemoCallout } from "@/components/demo/demo-callout";
import { AiPanel } from "@/components/incidents/ai-panel";
import { IncidentTimeline } from "@/components/incidents/incident-timeline";
import { OccurrenceChart } from "@/components/incidents/occurrence-chart";
import { StackTrace } from "@/components/incidents/stack-trace";
import { StatusActions } from "@/components/incidents/status-actions";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAiConfig } from "@/lib/ai/config";
import { formatNumber, formatRelative } from "@/lib/dashboard/format";
import { DEFAULT_EVENT_PARAMS, parseUuid } from "@/lib/incidents/params";
import {
  asRpc,
  fetchActivity,
  fetchDeployments,
  fetchLatestStackTrace,
  fetchEventPage,
  fetchHistogram,
  fetchIncident,
  fetchLatestAnalysis,
} from "@/lib/incidents/queries";
import { buildTimeline } from "@/lib/incidents/timeline";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Incident" };
export const dynamic = "force-dynamic";

const RELATED_PAGE_SIZE = 10;
const TIMELINE_EVENTS = 8;

function SummaryCard({ icon: Icon, label, children, title }: { icon: typeof Clock; label: string; children: React.ReactNode; title?: string }) {
  return (
    <Card size="sm" className="gap-1 px-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">{label}</h2>
        <Icon className="size-4 text-muted-foreground" aria-hidden />
      </div>
      <p className="truncate text-sm font-medium" title={title}>
        {children}
      </p>
    </Card>
  );
}

export default async function IncidentPage({ params, searchParams }: PageProps<"/incidents/[incidentId]">) {
  const { incidentId } = await params;
  // Route parameters are untrusted: a non-UUID is a 404 before any query runs.
  const id = parseUuid(incidentId);
  if (!id) notFound();

  const raw = await searchParams;
  const eventsPage = Math.max(1, Math.min(10_000, Number.parseInt(String(Array.isArray(raw.events_page) ? raw.events_page[0] : (raw.events_page ?? "1")), 10) || 1));
  const projectParam = parseUuid(Array.isArray(raw.project) ? raw.project[0] : raw.project);

  const supabase = await createClient();
  const db = asRpc(supabase);
  // Ownership is enforced by row level security inside this query: someone else's incident is simply "not found".
  const incident = await fetchIncident(db, id);
  if (!incident) notFound();

  const now = new Date();
  const eventParams = { ...DEFAULT_EVENT_PARAMS, project: null };
  const HOUR = 3_600_000;
  const [activity, histogram, related, latest, analysis, deployments] = await Promise.all([
    fetchActivity(db, id),
    fetchHistogram(db, id, 24),
    fetchEventPage(db, { ...eventParams, page: eventsPage }, { incidentId: id, pageSize: RELATED_PAGE_SIZE }, now),
    fetchEventPage(db, { ...eventParams, page: 1 }, { incidentId: id, pageSize: TIMELINE_EVENTS }, now),
    fetchLatestAnalysis(db, id),
    // Deployments within 6h of the incident, as timeline context. Best effort: never blocks the page.
    fetchDeployments(db, {
      project: incident.projectId,
      from: new Date(Date.parse(incident.firstSeenAt) - 6 * HOUR),
      to: new Date(Date.parse(incident.lastSeenAt) + 6 * HOUR),
    }).catch(() => []),
  ]);
  // Show the most recent stack trace that was actually captured: the newest event may have none.
  const latestTrace = await fetchLatestStackTrace(db, id);

  const timeline = buildTimeline({ incident, activity, events: latest.items, deployments });
  const nowIso = now.toISOString();
  const keep = projectParam ? `?project=${projectParam}` : "";
  const hrefForPage = (page: number) => {
    const search = new URLSearchParams(projectParam ? { project: projectParam } : {});
    if (page > 1) search.set("events_page", String(page));
    const text = search.toString();
    return `/incidents/${id}${text ? `?${text}` : ""}`;
  };
  const totalEvents = latest.total;

  return (
    <div className="space-y-6">
      <Link href={`/incidents${keep}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
        <ArrowLeft aria-hidden /> All incidents
      </Link>

      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-2">
          <h1 className="text-xl font-semibold tracking-tight break-words">{incident.title}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <SeverityBadge severity={incident.severity} />
            <StatusBadge status={incident.status} />
            <span className="tabular-nums">
              <span className="font-medium text-foreground">{formatNumber(incident.occurrenceCount)}</span>{" "}
              {incident.occurrenceCount === 1 ? "occurrence" : "occurrences"}
            </span>
            <span aria-hidden>·</span>
            <span>
              {incident.projectName} ({incident.environment})
            </span>
          </div>
        </div>
        <StatusActions incidentId={incident.id} status={incident.status} />
      </header>

      <DemoCallout step="incident" />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <section aria-label="Summary" className="grid gap-4 sm:grid-cols-3">
            <SummaryCard icon={Calendar} label="First seen" title={new Date(incident.firstSeenAt).toUTCString()}>
              {formatRelative(incident.firstSeenAt, nowIso)}
            </SummaryCard>
            <SummaryCard icon={Clock} label="Last seen" title={new Date(incident.lastSeenAt).toUTCString()}>
              {formatRelative(incident.lastSeenAt, nowIso)}
            </SummaryCard>
            <SummaryCard icon={Route} label="Affected endpoint" title={incident.endpoint ?? undefined}>
              <span className="font-mono text-xs">{incident.endpoint ?? "—"}</span>
            </SummaryCard>
          </section>

          <ChartCard title="Occurrences over time" description="Events grouped into this incident, between first and last seen.">
            <OccurrenceChart buckets={histogram} />
          </ChartCard>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Timeline</CardTitle>
              <CardDescription>Recent events and status changes, newest first.</CardDescription>
            </CardHeader>
            <CardContent>
              <IncidentTimeline entries={timeline} now={nowIso} hiddenEvents={Math.max(0, totalEvents - latest.items.length)} />
            </CardContent>
          </Card>

          <section aria-labelledby="stack-heading" className="space-y-2">
            <h2 id="stack-heading" className="text-sm font-medium">
              Latest stack trace
            </h2>
            <StackTrace trace={latestTrace} />
          </section>

          <Card className="gap-0 p-0">
            <CardHeader className="p-4">
              <CardTitle className="text-sm">Related events</CardTitle>
              <CardDescription>{related.total === 1 ? "The only event" : `All ${formatNumber(related.total)} events`} in this incident. Expand one for its attributes and stack trace.</CardDescription>
            </CardHeader>
            <ul aria-label="Related events" className="border-t border-border">
              {related.items.map((event) => (
                <EventRow key={event.id} event={event} now={nowIso} showIncident={false} />
              ))}
            </ul>
            <Pagination page={related.page} pageCount={related.pageCount} total={related.total} pageSize={RELATED_PAGE_SIZE} noun="events" hrefFor={hrefForPage} />
          </Card>
        </div>

        <aside aria-label="Investigation" className="min-w-0 lg:sticky lg:top-20 lg:self-start">
          <AiPanel key={`${analysis?.id ?? "none"}:${analysis?.status ?? ""}`} incidentId={incident.id} analysis={analysis} configured={getAiConfig() !== null} />
        </aside>
      </div>
    </div>
  );
}
