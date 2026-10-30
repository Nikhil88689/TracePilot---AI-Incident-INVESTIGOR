import { ArrowRightLeft, Flag, Rocket, TriangleAlert, type LucideIcon } from "lucide-react";
import { LevelBadge } from "@/components/dashboard/status-badges";
import { formatRelative } from "@/lib/dashboard/format";
import type { TimelineEntry } from "@/lib/incidents/timeline";
import { cn } from "@/lib/utils";

const ICON: Record<TimelineEntry["kind"], LucideIcon> = { event: TriangleAlert, status: ArrowRightLeft, first_seen: Flag, deployment: Rocket };

type Props = { entries: TimelineEntry[]; now: string; hiddenEvents: number };

/** Newest-first feed of events and status changes ending with the first-seen milestone. */
export function IncidentTimeline({ entries, now, hiddenEvents }: Props) {
  return (
    <ol aria-label="Incident timeline" className="relative space-y-0">
      {entries.map((entry, index) => {
        const Icon = ICON[entry.kind];
        const last = index === entries.length - 1;
        return (
          <li key={entry.id} className="relative flex gap-3 pb-4 last:pb-0">
            {!last ? <span aria-hidden className="absolute top-6 bottom-0 left-[11px] w-px bg-border" /> : null}
            <span
              className={cn(
                "relative z-10 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-card",
                entry.kind === "status" && "border-primary/40 text-primary",
                entry.kind === "deployment" && "border-warning/40 text-warning",
                entry.kind === "first_seen" && "text-muted-foreground",
              )}
            >
              <Icon className="size-3" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {entry.level ? <LevelBadge level={entry.level} /> : null}
                <p className={cn("min-w-0 text-sm break-words", entry.kind === "event" ? "line-clamp-2" : "font-medium")}>{entry.title}</p>
              </div>
              {entry.detail ? <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{entry.detail}</p> : null}
              <time dateTime={entry.at} title={new Date(entry.at).toUTCString()} className="mt-0.5 block text-xs text-muted-foreground">
                {formatRelative(entry.at, now)} · {new Date(entry.at).toISOString().replace("T", " ").slice(0, 19)} UTC
              </time>
              {entry.kind === "first_seen" && hiddenEvents > 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {hiddenEvents} earlier {hiddenEvents === 1 ? "event is" : "events are"} listed under Related events.
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
