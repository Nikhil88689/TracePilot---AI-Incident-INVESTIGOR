import { z } from "zod";
import { INCIDENT_STATUSES, SEVERITIES } from "@/lib/dashboard/types";
import { ENVIRONMENTS } from "@/lib/projects/schemas";

export const INCIDENTS_PAGE_SIZE = 20;
export const EVENTS_PAGE_SIZE = 25;

export const SINCE_VALUES = ["1h", "24h", "7d", "30d", "all"] as const;
export type Since = (typeof SINCE_VALUES)[number];

export const SINCE_LABELS: Record<Since, string> = {
  "1h": "Last hour",
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  all: "All time",
};

const SINCE_MS: Record<Exclude<Since, "all">, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

/** The lower bound for a "since" filter, or null for all time. */
export function sinceToFrom(since: Since, now: Date): Date | null {
  return since === "all" ? null : new Date(now.getTime() - SINCE_MS[since]);
}

export const INCIDENT_SORTS = ["last_seen", "first_seen", "occurrences", "severity", "status", "title", "endpoint"] as const;
export type IncidentSort = (typeof INCIDENT_SORTS)[number];
export type SortDir = "asc" | "desc";

export const EVENT_LEVELS = ["debug", "info", "warning", "error", "fatal"] as const;

type Raw = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const flatten = (raw: Raw) => Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, first(v)]));

// Every URL parameter is untrusted. `.catch` turns anything invalid into the default, so a
// hand-edited or stale URL always renders a sensible page instead of an error.
const page = z.coerce.number().int().min(1).max(100_000).catch(1);
const project = z.uuid().nullable().catch(null);
const since = z.enum(SINCE_VALUES).catch("all");

const incidentSchema = z.object({
  q: z.string().trim().max(100).catch(""),
  // "unresolved" = open + investigating (what the dashboard KPI counts)
  status: z.enum([...INCIDENT_STATUSES, "unresolved", "all"]).catch("all"),
  severity: z.enum([...SEVERITIES, "all"]).catch("all"),
  env: z.enum([...ENVIRONMENTS, "all"]).catch("all"),
  since,
  sort: z.enum(INCIDENT_SORTS).catch("last_seen"),
  dir: z.enum(["asc", "desc"]).catch("desc"),
  page,
  project,
});
export type IncidentListParams = z.infer<typeof incidentSchema>;

export function parseIncidentListParams(raw: Raw): IncidentListParams {
  return incidentSchema.parse(flatten(raw));
}

const eventSchema = z.object({
  q: z.string().trim().max(100).catch(""),
  type: z.string().trim().max(100).catch(""),
  level: z.enum([...EVENT_LEVELS, "all"]).catch("all"),
  endpoint: z.string().trim().max(300).catch(""),
  since,
  page,
  project,
});
export type EventListParams = z.infer<typeof eventSchema>;

export function parseEventListParams(raw: Raw): EventListParams {
  return eventSchema.parse(flatten(raw));
}

/** Route ids must be UUIDs; anything else is a 404 before any query runs. */
export const uuidSchema = z.uuid();
export function parseUuid(value: unknown): string | null {
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Builds a query string containing only values that differ from the defaults, keeping URLs short and stable. */
export function buildQuery<T extends Record<string, unknown>>(values: T, defaults: T): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined || value === "" || value === defaults[key]) continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export const DEFAULT_INCIDENT_PARAMS: IncidentListParams = parseIncidentListParams({});
export const DEFAULT_EVENT_PARAMS: EventListParams = parseEventListParams({});

/** URL for a list view with some params changed. Only non-default values are written, and "all projects" omits `project`. */
export function incidentListHref(path: string, params: IncidentListParams, patch: Partial<IncidentListParams> = {}): string {
  return `${path}${buildQuery({ ...params, ...patch }, DEFAULT_INCIDENT_PARAMS)}`;
}

export function eventListHref(path: string, params: EventListParams, patch: Partial<EventListParams> = {}): string {
  return `${path}${buildQuery({ ...params, ...patch }, DEFAULT_EVENT_PARAMS)}`;
}

/** The sort a header click should switch to: same column flips direction, a new column starts at its natural order. */
export function nextSort(current: { sort: IncidentSort; dir: SortDir }, key: IncidentSort): { sort: IncidentSort; dir: SortDir } {
  if (current.sort === key) return { sort: key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { sort: key, dir: key === "title" || key === "endpoint" ? "asc" : "desc" };
}
