"use client";

import { useId, useState, useTransition } from "react";
import { ChevronRight, Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { LevelBadge } from "@/components/dashboard/status-badges";
import { Button } from "@/components/ui/button";
import { formatRelative } from "@/lib/dashboard/format";
import { loadEventDetailAction } from "@/lib/incidents/actions";
import type { EventDetail, EventSummary } from "@/lib/incidents/types";
import { cn } from "@/lib/utils";
import { EventDetailPanel } from "./event-detail-panel";

type Props = {
  event: EventSummary;
  /** Server timestamp (ISO) so relative times match between server and client. */
  now: string;
  /** Show which incident the event belongs to (hidden on the incident page itself). */
  showIncident?: boolean;
  /** Query string preserved on links, e.g. "?project=…". */
  linkQuery?: string;
};

type Detail = { state: "idle" } | { state: "loading" } | { state: "error"; message: string } | { state: "ready"; event: EventDetail };

/**
 * One event. Collapsed it shows level, message, endpoint and time; expanding loads the heavy
 * fields (stack trace, attributes) on demand so list pages stay small.
 */
export function EventRow({ event, now, showIncident = true, linkQuery = "" }: Props) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Detail>({ state: "idle" });
  const [, startTransition] = useTransition();
  const panelId = useId();

  function load() {
    setDetail({ state: "loading" });
    startTransition(async () => {
      try {
        const result = await loadEventDetailAction({ eventId: event.id });
        setDetail(result.status === "ok" ? { state: "ready", event: result.event } : { state: "error", message: result.message });
      } catch {
        setDetail({ state: "error", message: "Could not load the event. Check your connection and try again." });
      }
    });
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && detail.state === "idle") load();
  }

  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/50"
      >
        <ChevronRight className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <LevelBadge level={event.level} />
            <span className="line-clamp-2 min-w-0 flex-1 text-sm font-medium break-words">{event.message}</span>
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span className="font-mono">{event.eventType}</span>
            {event.endpoint ? <span className="max-w-full truncate font-mono">{event.endpoint}</span> : null}
            <time dateTime={event.occurredAt} title={new Date(event.occurredAt).toUTCString()}>
              {formatRelative(event.occurredAt, now)}
            </time>
          </span>
        </span>
      </button>

      {open ? (
        <div id={panelId} role="region" aria-label="Event details" className="space-y-4 border-t border-border bg-background/50 px-4 py-3 sm:pl-10">
          {detail.state === "loading" ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Loading event…
            </p>
          ) : null}

          {detail.state === "error" ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
              <TriangleAlert className="size-4" aria-hidden /> {detail.message}
              <Button size="sm" variant="outline" onClick={load}>
                <RotateCcw aria-hidden /> Retry
              </Button>
            </div>
          ) : null}

          {detail.state === "ready" ? <EventDetailPanel event={detail.event} showIncident={showIncident} linkQuery={linkQuery} /> : null}
        </div>
      ) : null}
    </li>
  );
}
