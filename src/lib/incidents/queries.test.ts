import { describe, expect, it, vi } from "vitest";
import { DEFAULT_INCIDENT_PARAMS } from "./params";
import { DataError, changeIncidentStatus, fetchDashboardOverview, fetchIncident, fetchIncidentList, type RpcClient } from "./queries";

const ID = "11111111-1111-4111-8111-111111111111";
const row = (n: number, total: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, project_id: ID, project_name: "p", environment: "production", title: `T${n}`, severity: "high", status: "open",
  occurrence_count: "7", first_seen_at: "2026-10-30T10:00:00+00:00", last_seen_at: "2026-10-30T11:00:00+00:00", endpoint: null, total_count: String(total),
});

function rpcWith(handler: (fn: string, args: Record<string, unknown>) => { data?: unknown; error?: { code?: string; message: string } }) {
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown> = {}) => {
    const r = handler(fn, args);
    return { data: r.data ?? null, error: r.error ?? null };
  });
  return { db: { rpc } as RpcClient, rpc };
}

describe("data layer error handling", () => {
  it("wraps database errors in a DataError that carries only the function name and code", async () => {
    const { db } = rpcWith(() => ({ error: { code: "XX000", message: "row data: secret@example.com" } }));
    const error = await fetchIncidentList(db, DEFAULT_INCIDENT_PARAMS).catch((e) => e);
    expect(error).toBeInstanceOf(DataError);
    expect(error.message).toBe("database call list_incidents failed (XX000)");
    expect(error.message).not.toContain("secret");
  });

  it("rejects unexpected result shapes instead of passing bad data to the UI", async () => {
    const { db } = rpcWith(() => ({ data: [{ id: "not-a-uuid", title: 5 }] }));
    await expect(fetchIncidentList(db, DEFAULT_INCIDENT_PARAMS)).rejects.toMatchObject({ code: "bad_shape" });
  });

  it("coerces numeric strings and maps rows to camelCase", async () => {
    const { db } = rpcWith(() => ({ data: [row(1, 1)] }));
    const page = await fetchIncidentList(db, DEFAULT_INCIDENT_PARAMS);
    expect(page.items[0]).toMatchObject({ occurrenceCount: 7, projectName: "p", lastSeenAt: "2026-10-30T11:00:00+00:00", endpoint: null });
    expect(page.total).toBe(1);
  });
});

describe("fetchIncidentList parameter passing", () => {
  it("sends only validated, bound values and translates 'all' to null", async () => {
    const { db, rpc } = rpcWith(() => ({ data: [] }));
    const now = new Date("2026-10-30T12:00:00Z");
    await fetchIncidentList(db, { ...DEFAULT_INCIDENT_PARAMS, q: "cart", status: "open", severity: "all", env: "staging", since: "24h", sort: "occurrences", dir: "asc" }, now);
    expect(rpc).toHaveBeenCalledWith("list_incidents", {
      p_project: null, p_search: "cart", p_status: "open", p_severity: null, p_environment: "staging",
      p_from: "2026-10-29T12:00:00.000Z", p_to: "2026-10-30T12:00:00.000Z", p_sort: "occurrences", p_dir: "asc", p_limit: 20, p_offset: 0,
    });
  });

  it("computes the offset from the page", async () => {
    const { db, rpc } = rpcWith(() => ({ data: [row(1, 45)] }));
    await fetchIncidentList(db, { ...DEFAULT_INCIDENT_PARAMS, page: 3 });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_offset: 40, p_limit: 20 });
  });

  it("falls back to the last real page when asked for one past the end", async () => {
    const { db, rpc } = rpcWith((_fn, args) => {
      const offset = args.p_offset as number;
      if (offset >= 25) return { data: [] };
      return { data: Array.from({ length: Math.min(20, 25 - offset) }, (_, i) => row(offset + i, 25)) };
    });
    const page = await fetchIncidentList(db, { ...DEFAULT_INCIDENT_PARAMS, page: 50 });
    expect(page).toMatchObject({ page: 2, pageCount: 2, total: 25 });
    expect(page.items).toHaveLength(5);
    expect(rpc).toHaveBeenCalledTimes(3); // past-the-end, first page for the total, then the real last page
  });

  it("returns an empty first page when there are no results at all", async () => {
    const { db } = rpcWith(() => ({ data: [] }));
    expect(await fetchIncidentList(db, { ...DEFAULT_INCIDENT_PARAMS, page: 9 })).toMatchObject({ items: [], total: 0, page: 1, pageCount: 1 });
  });
});

describe("fetchIncident", () => {
  it("does not query for malformed ids", async () => {
    const { db, rpc } = rpcWith(() => ({ data: [] }));
    expect(await fetchIncident(db, "../../etc/passwd")).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("changeIncidentStatus", () => {
  it("maps the database's check-violation (invalid transition) to a domain result", async () => {
    const { db } = rpcWith(() => ({ error: { code: "23514", message: "invalid incident status transition" } }));
    // Bypass the client-side guard by using a pair the guard allows but the database refuses.
    expect(await changeIncidentStatus(db, { incidentId: ID, to: "resolved", expected: "open" })).toEqual({ result: "invalid_transition" });
  });

  it("throws a DataError for any other database failure", async () => {
    const { db } = rpcWith(() => ({ error: { code: "XX000", message: "x" } }));
    await expect(changeIncidentStatus(db, { incidentId: ID, to: "resolved", expected: "open" })).rejects.toBeInstanceOf(DataError);
  });

  it("rejects an unexpected response shape", async () => {
    const { db } = rpcWith(() => ({ data: { result: "maybe" } }));
    await expect(changeIncidentStatus(db, { incidentId: ID, to: "resolved", expected: "open" })).rejects.toMatchObject({ code: "bad_shape" });
  });
});

describe("fetchDashboardOverview", () => {
  const NOW = new Date("2026-10-30T12:00:00Z");
  const raw = (over: Record<string, unknown> = {}) => ({
    events: 200, errors: 10, prev_events: 100, prev_errors: 10, endpoints: 3, prev_endpoints: 0, unresolved: 4, first_event_at: "2026-10-01T00:00:00+00:00",
    series: [{ time: "2026-10-30T11:00:00+00:00", events: 100, errors: 5 }, { time: "2026-10-30T12:00:00+00:00", events: 0, errors: 0 }],
    severity: { critical: 2, high: 1 }, ...over,
  });
  const handler = (data: unknown, deployments: unknown[] = []) => (fn: string) =>
    fn === "incident_counts" ? { data: [{ unresolved: 4, critical: 2, recently_resolved: 1, total: 9 }] } : fn === "list_deployments" ? { data: deployments } : { data };

  it("derives rates and trends from real aggregates", async () => {
    const { db } = rpcWith(handler(raw()));
    const o = await fetchDashboardOverview(db, { project: null, range: "24h" }, NOW);
    const kpi = (id: string) => o.kpis.find((k) => k.id === id)!;
    expect(kpi("events")).toMatchObject({ value: 200, changePercent: 100, trendNote: null });
    expect(kpi("errorRate")).toMatchObject({ value: 5, changePercent: -50, detail: "10 errors of 200 events" }); // 5% now vs 10% before
    expect(kpi("unresolved")).toMatchObject({ value: 4, changePercent: null });
    expect(kpi("unresolved").trendNote).toMatch(/isn't tracked over time/);
    expect(kpi("endpoints")).toMatchObject({ value: 3, changePercent: null }); // previous was zero: no invented percentage
    expect(kpi("endpoints").trendNote).toMatch(/previous period was zero/);
    expect(o.series.map((p) => p.rate)).toEqual([5, null]); // an empty bucket is a gap, not 0%
    expect(o.severityBreakdown).toEqual([
      { severity: "critical", count: 2 }, { severity: "high", count: 1 }, { severity: "medium", count: 0 }, { severity: "low", count: 0 },
    ]);
    expect(o.counts).toEqual({ unresolved: 4, critical: 2, recentlyResolved: 1, total: 9 });
    expect(o.deployments).toEqual([]);
  });

  it("suppresses every trend when history does not cover the previous period", async () => {
    const { db } = rpcWith(handler(raw({ first_event_at: "2026-10-30T00:00:00+00:00" })));
    const o = await fetchDashboardOverview(db, { project: null, range: "24h" }, NOW);
    for (const id of ["events", "errorRate", "endpoints"]) {
      const k = o.kpis.find((x) => x.id === id)!;
      expect(k.changePercent, id).toBeNull();
      expect(k.trendNote, id).toMatch(/no data from before the previous period/);
    }
  });

  it("requires enough previous events before comparing error rates", async () => {
    const { db } = rpcWith(handler(raw({ prev_events: 5, prev_errors: 1 })));
    const o = await fetchDashboardOverview(db, { project: null, range: "24h" }, NOW);
    const k = o.kpis.find((x) => x.id === "errorRate")!;
    expect(k.changePercent).toBeNull();
    expect(k.trendNote).toBeTruthy();
  });

  it("handles a project with no data (zero division safe, no invented trends or zeros)", async () => {
    const { db } = rpcWith(handler(raw({ events: 0, errors: 0, prev_events: 0, prev_errors: 0, endpoints: 0, unresolved: 0, first_event_at: null, series: [{ time: "2026-10-30T11:00:00+00:00", events: 0, errors: 0 }], severity: {} })));
    const o = await fetchDashboardOverview(db, { project: null, range: "1h" }, NOW);
    expect(o.kpis.map((k) => k.value)).toEqual([0, 0, 0, 0]);
    expect(o.kpis.every((k) => k.changePercent === null && k.trendNote)).toBe(true);
    expect(o.kpis.find((k) => k.id === "errorRate")!.detail).toBe("No events in this window");
    expect(o.series[0].rate).toBeNull();
  });

  it("uses the range's window, bucket count and the same window for deployments", async () => {
    const { db, rpc } = rpcWith(handler(raw()));
    await fetchDashboardOverview(db, { project: { id: ID, name: "p", workspace: "", environment: "production" }, range: "7d" }, NOW);
    const call = rpc.mock.calls.find((c) => c[0] === "dashboard_overview")!;
    expect(call[1]).toEqual({ p_project: ID, p_from: "2026-10-23T12:00:00.000Z", p_to: "2026-10-30T12:00:00.000Z", p_buckets: 28 });
    expect(rpc.mock.calls.find((c) => c[0] === "list_deployments")![1]).toEqual({ p_project: ID, p_from: "2026-10-23T12:00:00.000Z", p_to: "2026-10-30T12:00:00.000Z" });
  });

  it("maps deployments", async () => {
    const dep = { id: "11111111-1111-4111-8111-111111111111", project_id: ID, version: "2.14.0", description: "d", deployed_at: "2026-10-30T10:00:00+00:00", source: "demo" };
    const { db } = rpcWith(handler(raw(), [dep]));
    const o = await fetchDashboardOverview(db, { project: null, range: "24h" }, NOW);
    expect(o.deployments).toEqual([{ id: dep.id, projectId: ID, version: "2.14.0", description: "d", deployedAt: dep.deployed_at, source: "demo" }]);
  });

  it("fails the whole overview when an underlying query fails (the page isolates that as a section error)", async () => {
    const { db } = rpcWith((fn) => (fn === "dashboard_overview" ? { error: { code: "XX000", message: "x" } } : handler(raw())(fn)));
    await expect(fetchDashboardOverview(db, { project: null, range: "24h" }, NOW)).rejects.toBeInstanceOf(DataError);
  });
});
