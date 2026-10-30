import type { IncidentStatus } from "@/lib/dashboard/types";
import { STATUS_LABELS } from "./transitions";
import type { ActivityEntry, EventLevel, EventSummary, IncidentDetail } from "./types";

export type TimelineEntry = {
  id: string;
  /** ISO 8601 */
  at: string;
  kind: "event" | "status" | "first_seen" | "deployment";
  title: string;
  detail?: string;
  level?: EventLevel;
  to?: IncidentStatus;
};

function describeStatusChange(a: ActivityEntry): { title: string; detail?: string } {
  const from = a.fromStatus ? STATUS_LABELS[a.fromStatus] : "—";
  const to = a.toStatus ? STATUS_LABELS[a.toStatus] : "—";
  if (a.actor === "system" && a.fromStatus === "resolved" && a.toStatus === "open") {
    return { title: "Reopened automatically", detail: "The error occurred again after it was resolved." };
  }
  const who = a.actor === "you" ? "You" : a.actor === "system" ? "TracePilot" : "A teammate";
  return { title: `${who} changed the status`, detail: `${from} → ${to}` };
}

/**
 * Merges status changes and recent events into one newest-first feed, ending with the
 * "first seen" milestone. Pure so the ordering rules are easy to test.
 */
export type TimelineDeployment = { id: string; version: string; description: string | null; deployedAt: string };

export function buildTimeline(input: {
  incident: Pick<IncidentDetail, "firstSeenAt" | "id">;
  activity: ActivityEntry[];
  events: EventSummary[];
  /** Deployments near the incident, as recorded (context, shown in time order with everything else). */
  deployments?: TimelineDeployment[];
}): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...input.activity.map((a): TimelineEntry => ({ id: `a-${a.id}`, at: a.createdAt, kind: "status", to: a.toStatus ?? undefined, ...describeStatusChange(a) })),
    ...(input.deployments ?? []).map((d): TimelineEntry => ({ id: `d-${d.id}`, at: d.deployedAt, kind: "deployment", title: `Deployed v${d.version}`, detail: d.description ?? undefined })),
    ...input.events.map((e): TimelineEntry => ({
      id: `e-${e.id}`,
      at: e.occurredAt,
      kind: "event",
      level: e.level,
      title: e.message,
      detail: [e.eventType, e.endpoint].filter(Boolean).join(" · "),
    })),
  ].sort((x, y) => Date.parse(y.at) - Date.parse(x.at) || x.id.localeCompare(y.id));

  entries.push({ id: "first-seen", at: input.incident.firstSeenAt, kind: "first_seen", title: "First seen", detail: "The first event of this incident was received." });
  return entries;
}
