import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { INCIDENT_STATUSES, SEVERITIES, type DashboardOverview, type IncidentStatus, type Kpi, type Project, type TimeRange } from "@/lib/dashboard/types";
import { RANGE_MS } from "@/lib/dashboard/params";
import { formatNumber } from "@/lib/dashboard/format";
import { DEMO } from "@/lib/demo/scenario";
import { METRIC_DEFINITIONS, RANGE_BUCKETS, baselineCovered, computeTrend, errorRate, windowBounds } from "@/lib/dashboard/metrics";
import {
  EVENTS_PAGE_SIZE,
  INCIDENTS_PAGE_SIZE,
  parseUuid,
  sinceToFrom,
  type EventListParams,
  type IncidentListParams,
} from "./params";
import { canTransition } from "./transitions";
import type {
  ActivityEntry,
  EventDetail,
  EventFilterOptions,
  EventSummary,
  HistogramBucket,
  IncidentCounts,
  IncidentDetail,
  IncidentSummary,
  Page,
} from "./types";

type RpcResult = { data: unknown; error: { code?: string; message: string } | null };

/** The one capability the data layer needs from a database client. Satisfied by supabase-js and by test doubles. */
export interface RpcClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult>;
}

export const asRpc = (client: SupabaseClient): RpcClient => client as unknown as RpcClient;

/** Database failure. The message is safe to log; it never contains row data. */
export class DataError extends Error {
  constructor(
    public readonly fn: string,
    public readonly code?: string,
  ) {
    super(`database call ${fn} failed${code ? ` (${code})` : ""}`);
    this.name = "DataError";
  }
}

async function call<T>(db: RpcClient, fn: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new DataError(fn, error.code);
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new DataError(fn, "bad_shape");
  return parsed.data;
}

const ts = z.string();
const num = z.coerce.number();
const severity = z.enum(SEVERITIES);
const status = z.enum(INCIDENT_STATUSES);

// ---- incidents -----------------------------------------------------------------------------

const incidentRow = z.object({
  id: z.uuid(),
  project_id: z.uuid(),
  project_name: z.string(),
  environment: z.string(),
  title: z.string(),
  severity,
  status,
  occurrence_count: num,
  first_seen_at: ts,
  last_seen_at: ts,
  endpoint: z.string().nullable(),
});
const incidentListRow = incidentRow.extend({ total_count: num });

const toIncident = (r: z.infer<typeof incidentRow>): IncidentSummary => ({
  id: r.id,
  projectId: r.project_id,
  projectName: r.project_name,
  environment: r.environment,
  title: r.title,
  severity: r.severity,
  status: r.status,
  occurrenceCount: r.occurrence_count,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
  endpoint: r.endpoint,
});

/** Runs a paged query; if the requested page is past the end, returns the last real page instead of an empty one. */
async function paged<R extends { total_count: number }, T>(
  run: (offset: number) => Promise<R[]>,
  map: (row: R) => T,
  page: number,
  pageSize: number,
): Promise<Page<T>> {
  let rows = await run((page - 1) * pageSize);
  let current = page;

  if (rows.length === 0 && page > 1) {
    // Past the end (e.g. a stale bookmark after filtering): total is unknown from an empty page.
    const firstPage = await run(0);
    const total = firstPage[0]?.total_count ?? 0;
    current = Math.max(1, Math.ceil(total / pageSize));
    rows = current === 1 ? firstPage : await run((current - 1) * pageSize);
  }
  const total = rows[0]?.total_count ?? 0;
  return { items: rows.map(map), total, page: current, pageCount: Math.max(1, Math.ceil(total / pageSize)), pageSize };
}

export async function fetchIncidentList(db: RpcClient, params: IncidentListParams, now = new Date()): Promise<Page<IncidentSummary>> {
  const from = sinceToFrom(params.since, now);
  return paged<z.infer<typeof incidentListRow>, IncidentSummary>(
    (offset) =>
      call(
        db,
        "list_incidents",
        {
          p_project: params.project,
          p_search: params.q || null,
          p_status: params.status === "all" ? null : params.status,
          p_severity: params.severity === "all" ? null : params.severity,
          p_environment: params.env === "all" ? null : params.env,
          p_from: from?.toISOString() ?? null,
          // Half-open window [from, now): matches the dashboard, so counts agree at the boundary.
          p_to: from ? now.toISOString() : null,
          p_sort: params.sort,
          p_dir: params.dir,
          p_limit: INCIDENTS_PAGE_SIZE,
          p_offset: offset,
        },
        z.array(incidentListRow),
      ),
    toIncident,
    params.page,
    INCIDENTS_PAGE_SIZE,
  );
}

const countsRow = z.array(z.object({ unresolved: num, critical: num, recently_resolved: num, total: num }));

export async function fetchIncidentCounts(db: RpcClient, scope: { project: string | null; environment?: string | null }): Promise<IncidentCounts> {
  const [row] = await call(db, "incident_counts", { p_project: scope.project, p_environment: scope.environment ?? null }, countsRow);
  return { unresolved: row?.unresolved ?? 0, critical: row?.critical ?? 0, recentlyResolved: row?.recently_resolved ?? 0, total: row?.total ?? 0 };
}

export async function fetchUnresolvedByProject(db: RpcClient): Promise<Record<string, number>> {
  const rows = await call(db, "unresolved_by_project", {}, z.array(z.object({ project_id: z.uuid(), unresolved: num })));
  return Object.fromEntries(rows.map((r) => [r.project_id, r.unresolved]));
}

const detailRow = incidentRow.extend({ fingerprint: z.string(), resolved_at: ts.nullable() });

/** Null when the id is malformed, does not exist, or belongs to someone else (indistinguishable by design). */
export async function fetchIncident(db: RpcClient, id: string): Promise<IncidentDetail | null> {
  const valid = parseUuid(id);
  if (!valid) return null;
  const [row] = await call(db, "get_incident", { p_id: valid }, z.array(detailRow));
  return row ? { ...toIncident(row), fingerprint: row.fingerprint, resolvedAt: row.resolved_at } : null;
}

export async function fetchActivity(db: RpcClient, incidentId: string): Promise<ActivityEntry[]> {
  const rows = await call(
    db,
    "list_incident_activity",
    { p_incident: incidentId, p_limit: 50 },
    z.array(z.object({ id: z.uuid(), from_status: status.nullable(), to_status: status.nullable(), actor: z.enum(["you", "system", "teammate"]), created_at: ts })),
  );
  return rows.map((r) => ({ id: r.id, fromStatus: r.from_status, toStatus: r.to_status, actor: r.actor, createdAt: r.created_at }));
}

export async function fetchHistogram(db: RpcClient, incidentId: string, buckets = 24): Promise<HistogramBucket[]> {
  const rows = await call(
    db,
    "incident_histogram",
    { p_incident: incidentId, p_buckets: buckets },
    z.array(z.object({ bucket_start: ts, bucket_end: ts, event_count: num })),
  );
  return rows.map((r) => ({ start: r.bucket_start, end: r.bucket_end, count: r.event_count }));
}

// ---- events ------------------------------------------------------------------------------

const eventRow = z.object({
  id: z.uuid(),
  project_id: z.uuid(),
  project_name: z.string(),
  external_event_id: z.string(),
  event_type: z.string(),
  level: z.enum(["debug", "info", "warning", "error", "fatal"]),
  message: z.string(),
  endpoint: z.string().nullable(),
  occurred_at: ts,
  incident_id: z.uuid().nullable(),
  incident_title: z.string().nullable(),
});
const eventListRow = eventRow.extend({ total_count: num, stack_trace: z.string().nullable(), attributes: z.record(z.string(), z.unknown()).nullable() });
const eventDetailRow = eventRow.extend({ stack_trace: z.string().nullable(), attributes: z.record(z.string(), z.unknown()) });

const toEvent = (r: z.infer<typeof eventRow>): EventSummary => ({
  id: r.id,
  projectId: r.project_id,
  projectName: r.project_name,
  externalEventId: r.external_event_id,
  eventType: r.event_type,
  level: r.level,
  message: r.message,
  endpoint: r.endpoint,
  occurredAt: r.occurred_at,
  incidentId: r.incident_id,
  incidentTitle: r.incident_title,
});

type EventScope = { incidentId?: string; includeDetails?: boolean; pageSize?: number };

export async function fetchEventPage(
  db: RpcClient,
  params: Pick<EventListParams, "q" | "type" | "level" | "endpoint" | "since" | "page" | "project">,
  scope: EventScope = {},
  now = new Date(),
): Promise<Page<EventSummary>> {
  const pageSize = scope.pageSize ?? EVENTS_PAGE_SIZE;
  const from = sinceToFrom(params.since, now);
  return paged<z.infer<typeof eventListRow>, EventSummary>(
    (offset) =>
      call(
        db,
        "list_events",
        {
          p_project: params.project,
          p_search: params.q || null,
          p_event_type: params.type || null,
          p_level: params.level === "all" ? null : params.level,
          p_endpoint: params.endpoint || null,
          p_from: from?.toISOString() ?? null,
          p_to: from ? now.toISOString() : null,
          p_incident: scope.incidentId ?? null,
          p_include_details: scope.includeDetails ?? false,
          p_limit: pageSize,
          p_offset: offset,
        },
        z.array(eventListRow),
      ),
    toEvent,
    params.page,
    pageSize,
  );
}

export async function fetchEventDetail(db: RpcClient, id: string): Promise<EventDetail | null> {
  const valid = parseUuid(id);
  if (!valid) return null;
  const [row] = await call(db, "get_event", { p_id: valid }, z.array(eventDetailRow));
  return row ? { ...toEvent(row), stackTrace: row.stack_trace, attributes: row.attributes } : null;
}

export async function fetchEventFilterOptions(db: RpcClient, project: string | null): Promise<EventFilterOptions> {
  const data = await call(
    db,
    "event_filter_options",
    { p_project: project },
    z.object({ event_types: z.array(z.string()), endpoints: z.array(z.string()) }),
  );
  return { eventTypes: data.event_types, endpoints: data.endpoints };
}

// ---- status changes ----------------------------------------------------------------------

export type StatusChangeResult =
  | { result: "ok"; status: IncidentStatus; resolvedAt: string | null }
  | { result: "conflict"; status: IncidentStatus }
  | { result: "not_found" }
  | { result: "invalid_transition" }
  | { result: "invalid_input" };

/**
 * Changes an incident's status only if it is still in `expected` (optimistic concurrency, so two
 * people clicking at once cannot silently overwrite each other). Ownership is enforced by RLS
 * inside the database function: someone else's incident behaves exactly like a missing one.
 */
export async function changeIncidentStatus(
  db: RpcClient,
  input: { incidentId: unknown; to: unknown; expected: unknown },
): Promise<StatusChangeResult> {
  const id = parseUuid(input.incidentId);
  const to = status.safeParse(input.to);
  const expected = status.safeParse(input.expected);
  if (!id || !to.success || !expected.success) return { result: "invalid_input" };
  if (!canTransition(expected.data, to.data)) return { result: "invalid_transition" };

  const { data, error } = await db.rpc("change_incident_status", { p_id: id, p_to: to.data, p_expected: expected.data });
  if (error) {
    if (error.code === "23514") return { result: "invalid_transition" };
    throw new DataError("change_incident_status", error.code);
  }
  const parsed = z
    .discriminatedUnion("result", [
      z.object({ result: z.literal("ok"), status, resolved_at: ts.nullable().optional() }),
      z.object({ result: z.literal("conflict"), status }),
      z.object({ result: z.literal("not_found") }),
    ])
    .safeParse(data);
  if (!parsed.success) throw new DataError("change_incident_status", "bad_shape");
  return parsed.data.result === "ok"
    ? { result: "ok", status: parsed.data.status, resolvedAt: parsed.data.resolved_at ?? null }
    : parsed.data;
}

// ---- dashboard ---------------------------------------------------------------------------
// Formulas and the rules for when a trend may be shown live in src/lib/dashboard/metrics.ts.

const overviewSchema = z.object({
  events: num,
  errors: num,
  prev_events: num,
  prev_errors: num,
  endpoints: num,
  prev_endpoints: num,
  unresolved: num,
  first_event_at: ts.nullable(),
  series: z.array(z.object({ time: ts, events: num, errors: num })),
  severity: z.record(z.string(), num),
});

const deploymentRow = z.object({ id: z.uuid(), project_id: z.uuid(), version: z.string(), description: z.string().nullable(), deployed_at: ts, source: z.enum(["api", "demo"]) });

export type Deployment = { id: string; projectId: string; version: string; description: string | null; deployedAt: string; source: "api" | "demo" };

/** Deployments in [from, to) for a project (or all non-demo projects), oldest first. */
export async function fetchDeployments(db: RpcClient, scope: { project: string | null; from: Date; to: Date }): Promise<Deployment[]> {
  const rows = await call(db, "list_deployments", { p_project: scope.project, p_from: scope.from.toISOString(), p_to: scope.to.toISOString() }, z.array(deploymentRow));
  return rows.map((r) => ({ id: r.id, projectId: r.project_id, version: r.version, description: r.description, deployedAt: r.deployed_at, source: r.source }));
}

export type OverviewData = DashboardOverview & { counts: IncidentCounts; deployments: Deployment[] };

/**
 * Real KPIs, time series and severity mix for one project (or all non-demo projects when `project` is
 * null), over the half-open UTC window [now - range, now). Nothing here is estimated: counts come from
 * SQL, and a trend is only produced when computeTrend says a comparison is meaningful.
 */
export async function fetchDashboardOverview(
  db: RpcClient,
  scope: { project: Project | null; range: TimeRange },
  now = new Date(),
): Promise<OverviewData> {
  const { from, to, previousFrom } = windowBounds(now, RANGE_MS[scope.range]);
  const projectId = scope.project?.id ?? null;
  const [data, counts, deployments] = await Promise.all([
    call(db, "dashboard_overview", { p_project: projectId, p_from: from.toISOString(), p_to: to.toISOString(), p_buckets: RANGE_BUCKETS[scope.range] }, overviewSchema),
    fetchIncidentCounts(db, { project: projectId }),
    fetchDeployments(db, { project: projectId, from, to }),
  ]);

  const covered = baselineCovered(data.first_event_at, previousFrom);
  const rateNow = errorRate(data.errors, data.events);
  const ratePrev = errorRate(data.prev_errors, data.prev_events);
  const trend = (kind: "count" | "rate", current: number | null, previous: number | null) =>
    computeTrend({ kind, current, previous, covered, baselineEvents: data.prev_events });

  const eventsTrend = trend("count", data.events, data.prev_events);
  const rateTrend = trend("rate", rateNow, ratePrev);
  const endpointsTrend = trend("count", data.endpoints, data.prev_endpoints);

  const kpis: Kpi[] = [
    {
      id: "events", label: METRIC_DEFINITIONS.events.label, value: data.events, format: "number", higherIs: "neutral",
      detail: null, ...eventsTrend,
    },
    {
      id: "errorRate", label: METRIC_DEFINITIONS.errorRate.label, value: rateNow ?? 0, format: "percent", higherIs: "bad",
      detail: data.events === 0 ? "No events in this window" : `${formatNumber(data.errors)} ${data.errors === 1 ? "error" : "errors"} of ${formatNumber(data.events)} ${data.events === 1 ? "event" : "events"}`, ...rateTrend,
    },
    {
      id: "unresolved", label: METRIC_DEFINITIONS.unresolved.label, value: data.unresolved, format: "number", higherIs: "bad",
      detail: null, changePercent: null, trendNote: "Incident status isn't tracked over time, so there is no previous-period comparison.",
    },
    {
      id: "endpoints", label: METRIC_DEFINITIONS.endpoints.label, value: data.endpoints, format: "number", higherIs: "bad",
      detail: null, ...endpointsTrend,
    },
  ];

  return {
    generatedAt: now.toISOString(),
    range: scope.range,
    kpis,
    series: data.series.map((p) => ({ time: p.time, events: p.events, errors: p.errors, rate: errorRate(p.errors, p.events) })),
    severityBreakdown: SEVERITIES.map((s) => ({ severity: s, count: data.severity[s] ?? 0 })),
    counts,
    deployments,
  };
}

// ---- AI analysis -------------------------------------------------------------------------

export type EvidenceReason = "recent" | "first_seen" | "representative";
export type EvidenceEvent = Pick<EventDetail, "id" | "externalEventId" | "eventType" | "level" | "message" | "endpoint" | "occurredAt" | "stackTrace" | "attributes"> & { reason: EvidenceReason };

const evidenceRow = z.object({
  id: z.uuid(),
  external_event_id: z.string(),
  event_type: z.string(),
  level: z.enum(["debug", "info", "warning", "error", "fatal"]),
  message: z.string(),
  endpoint: z.string().nullable(),
  occurred_at: ts,
  stack_trace: z.string().nullable(),
  attributes: z.record(z.string(), z.unknown()).nullable(),
  reason: z.enum(["recent", "first_seen", "representative"]),
});

/**
 * A bounded, representative selection of an incident's events with full detail: the newest few, the
 * first-seen event, and one per distinct message/stack shape. Newest first.
 */
export async function fetchEvidenceEvents(db: RpcClient, incidentId: string, opts: { recent?: number; representative?: number } = {}): Promise<EvidenceEvent[]> {
  const rows = await call(
    db,
    "select_evidence_events",
    { p_incident: incidentId, p_recent: opts.recent ?? 6, p_representative: opts.representative ?? 4 },
    z.array(evidenceRow),
  );
  return rows.map((r) => ({
    id: r.id,
    externalEventId: r.external_event_id,
    eventType: r.event_type,
    level: r.level,
    message: r.message,
    endpoint: r.endpoint,
    occurredAt: r.occurred_at,
    stackTrace: r.stack_trace,
    attributes: r.attributes ?? {},
    reason: r.reason,
  }));
}

/** The newest event of an incident that has a stack trace, if any (for the incident page). */
export async function fetchLatestStackTrace(db: RpcClient, incidentId: string): Promise<string | null> {
  const events = await fetchEvidenceEvents(db, incidentId, { recent: 10, representative: 0 });
  return events.find((e) => e.stackTrace)?.stackTrace ?? null;
}

const analysisRow = z.object({
  id: z.uuid(),
  status: z.enum(["pending", "complete", "failed"]),
  summary: z.string().nullable(),
  hypotheses: z.array(
    z.object({
      title: z.string(),
      explanation: z.string(),
      confidence: z.enum(["low", "medium", "high"]),
      evidence: z.array(z.object({ eventId: z.string(), occurredAt: z.string(), message: z.string(), why: z.string().default("") })),
    }),
  ),
  recommended_steps: z.array(z.object({ step: z.string(), rationale: z.string().nullable().optional() })),
  missing_information: z.array(z.string()),
  limitations: z.array(z.string()),
  completed_steps: z.array(num),
  input_event_count: num.nullable(),
  usage: z.object({ inputTokens: num, outputTokens: num }).nullable(),
  model: z.string().nullable(),
  error_message: z.string().nullable(),
  error_code: z.string().nullable(),
  retryable: z.boolean(),
  created_at: ts,
  completed_at: ts.nullable(),
});

export async function fetchLatestAnalysis(db: RpcClient, incidentId: string): Promise<import("./types").Analysis | null> {
  const [row] = await call(db, "get_latest_analysis", { p_incident: incidentId }, z.array(analysisRow));
  return row
    ? {
        id: row.id,
        status: row.status,
        summary: row.summary,
        hypotheses: row.hypotheses,
        recommendedSteps: row.recommended_steps.map((s) => ({ step: s.step, rationale: s.rationale ?? null })),
        missingInformation: row.missing_information,
        limitations: row.limitations,
        completedSteps: row.completed_steps,
        inputEventCount: row.input_event_count,
        model: row.model,
        usage: row.usage,
        errorMessage: row.error_message,
        errorCode: row.error_code,
        retryable: row.retryable,
        createdAt: row.created_at,
        completedAt: row.completed_at,
        simulated: row.model === DEMO.analysisModel,
      }
    : null;
}

export type StepResult = { result: "ok"; completedSteps: number[] } | { result: "not_found" } | { result: "invalid_input" };

/** Ticks a recommended step on or off. Persisted so the checklist survives refresh. */
export async function setAnalysisStep(db: RpcClient, input: { analysisId: unknown; index: unknown; done: unknown }): Promise<StepResult> {
  const id = parseUuid(input.analysisId);
  const index = z.number().int().min(0).max(50).safeParse(input.index);
  const done = z.boolean().safeParse(input.done);
  if (!id || !index.success || !done.success) return { result: "invalid_input" };

  const { data, error } = await db.rpc("set_analysis_step", { p_analysis: id, p_index: index.data, p_done: done.data });
  if (error) throw new DataError("set_analysis_step", error.code);
  const parsed = z
    .discriminatedUnion("result", [
      z.object({ result: z.literal("ok"), completed_steps: z.array(num) }),
      z.object({ result: z.literal("not_found") }),
      z.object({ result: z.literal("invalid_index") }),
    ])
    .safeParse(data);
  if (!parsed.success) throw new DataError("set_analysis_step", "bad_shape");
  if (parsed.data.result === "ok") return { result: "ok", completedSteps: parsed.data.completed_steps };
  return parsed.data.result === "invalid_index" ? { result: "invalid_input" } : { result: "not_found" };
}
