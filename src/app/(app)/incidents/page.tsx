import type { Metadata } from "next";
import { Inbox, SearchX } from "lucide-react";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { Pagination } from "@/components/common/pagination";
import { ClearIncidentFilters, IncidentFilters } from "@/components/incidents/incident-filters";
import { IncidentSummary } from "@/components/incidents/incident-summary";
import { IncidentTable } from "@/components/incidents/incident-table";
import { SendTestEventButton } from "@/components/layout/send-test-event-button";
import { Card } from "@/components/ui/card";
import { INCIDENTS_PAGE_SIZE, incidentListHref, nextSort, parseIncidentListParams } from "@/lib/incidents/params";
import { asRpc, fetchIncidentCounts, fetchIncidentList } from "@/lib/incidents/queries";
import { resolveProjectScope } from "@/lib/incidents/scope";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Incidents" };
export const dynamic = "force-dynamic";

export default async function IncidentsPage({ searchParams }: PageProps<"/incidents">) {
  const parsed = parseIncidentListParams(await searchParams);
  const supabase = await createClient();
  const { project } = await resolveProjectScope(supabase, parsed.project);
  // A project id that is not the caller's own is dropped, never trusted.
  const params = { ...parsed, project: project?.id ?? null };

  const db = asRpc(supabase);
  const now = new Date();
  const [list, counts] = await Promise.all([
    fetchIncidentList(db, params, now),
    fetchIncidentCounts(db, { project: params.project, environment: params.env === "all" ? null : params.env }),
  ]);

  // Paging may have been clamped (stale bookmark past the last page); links use the real page.
  const current = { ...params, page: list.page };
  const filtersActive = params.q !== "" || params.status !== "all" || params.severity !== "all" || params.env !== "all" || params.since !== "all";
  const detailQuery = params.project ? `?project=${params.project}` : "";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Incidents"
        description="Related errors grouped into incidents. Select one to see its timeline, events, and stack trace."
      />

      <IncidentSummary counts={counts} />

      <Card className="gap-0 p-0">
        <IncidentFilters values={{ q: params.q, status: params.status, severity: params.severity, env: params.env, since: params.since }} />

        {list.total === 0 ? (
          filtersActive ? (
            <EmptyState
              icon={SearchX}
              title="No incidents match your filters"
              description="Try a different search, or clear the filters to see everything."
              action={<ClearIncidentFilters />}
            />
          ) : (
            <EmptyState
              icon={Inbox}
              title="No incidents yet"
              description="Incidents appear when your application sends error events. Send a test event to see how grouping works."
              action={<SendTestEventButton />}
            />
          )
        ) : (
          <>
            <IncidentTable
              items={list.items}
              now={now.toISOString()}
              detailQuery={detailQuery}
              sort={{
                key: params.sort,
                dir: params.dir,
                hrefFor: (key) => incidentListHref("/incidents", current, { ...nextSort(params, key), page: 1 }),
              }}
            />
            <Pagination
              page={list.page}
              pageCount={list.pageCount}
              total={list.total}
              pageSize={INCIDENTS_PAGE_SIZE}
              noun="incidents"
              hrefFor={(page) => incidentListHref("/incidents", current, { page })}
            />
          </>
        )}
      </Card>
    </div>
  );
}
