import type { Metadata } from "next";
import { Activity, SearchX } from "lucide-react";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { Pagination } from "@/components/common/pagination";
import { ClearEventFilters, EventFilters } from "@/components/events/event-filters";
import { EventRow } from "@/components/events/event-row";
import { SendTestEventButton } from "@/components/layout/send-test-event-button";
import { Card } from "@/components/ui/card";
import { EVENTS_PAGE_SIZE, eventListHref, parseEventListParams } from "@/lib/incidents/params";
import { asRpc, fetchEventFilterOptions, fetchEventPage } from "@/lib/incidents/queries";
import { resolveProjectScope } from "@/lib/incidents/scope";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Events" };
export const dynamic = "force-dynamic";

export default async function EventsPage({ searchParams }: PageProps<"/events">) {
  const parsed = parseEventListParams(await searchParams);
  const supabase = await createClient();
  const { projects, project } = await resolveProjectScope(supabase, parsed.project);
  const params = { ...parsed, project: project?.id ?? null };

  const db = asRpc(supabase);
  const now = new Date();
  const [list, options] = await Promise.all([fetchEventPage(db, params, {}, now), fetchEventFilterOptions(db, params.project)]);

  const current = { ...params, page: list.page };
  const filtersActive = params.q !== "" || params.type !== "" || params.level !== "all" || params.endpoint !== "" || params.since !== "all";
  const linkQuery = params.project ? `?project=${params.project}` : "";

  return (
    <div className="space-y-6">
      <PageHeader title="Events" description="Every event your applications have sent, at any level. Expand one for its attributes and stack trace." />

      <Card className="gap-0 p-0">
        <EventFilters
          values={{ q: params.q, type: params.type, level: params.level, endpoint: params.endpoint, since: params.since, project: params.project ?? "" }}
          options={options}
          projects={projects.map((p) => ({ id: p.id, name: p.name }))}
        />

        {list.total === 0 ? (
          filtersActive || params.project ? (
            <EmptyState
              icon={SearchX}
              title="No events match your filters"
              description="Try a different search or time range, or clear the filters."
              action={<ClearEventFilters />}
            />
          ) : (
            <EmptyState
              icon={Activity}
              title="No events yet"
              description="Events appear here as soon as an application sends one. Send a test event to try it."
              action={<SendTestEventButton />}
            />
          )
        ) : (
          <>
            <ul aria-label="Events" className="border-t border-border">
              {list.items.map((event) => (
                <EventRow key={event.id} event={event} now={now.toISOString()} linkQuery={linkQuery} />
              ))}
            </ul>
            <Pagination
              page={list.page}
              pageCount={list.pageCount}
              total={list.total}
              pageSize={EVENTS_PAGE_SIZE}
              noun="events"
              hrefFor={(page) => eventListHref("/events", current, { page })}
            />
          </>
        )}
      </Card>
    </div>
  );
}
