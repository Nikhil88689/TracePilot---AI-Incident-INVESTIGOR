/**
 * The incidents / events / dashboard data layer, end to end on a real Postgres, as real
 * signed-in users (role `authenticated`, RLS active). Nothing here is mocked.
 */
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  changeIncidentStatus,
  fetchActivity,
  fetchDashboardOverview,
  fetchEventDetail,
  fetchEventFilterOptions,
  fetchEventPage,
  fetchHistogram,
  fetchIncident,
  fetchIncidentCounts,
  fetchIncidentList,
  fetchUnresolvedByProject,
} from "../../src/lib/incidents/queries";
import { DEFAULT_EVENT_PARAMS, DEFAULT_INCIDENT_PARAMS, type EventListParams, type IncidentListParams } from "../../src/lib/incidents/params";
import { adminPool, buildEvent, createUserAndProject, ingestEvents, servicePool } from "./pg-harness";
import { createPgRpc } from "./pg-rpc";

const port = Number(process.env.TP_TEST_PG_PORT);
let admin: pg.Pool;
let service: pg.Pool;

const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const DAY = 86_400_000;

type World = {
  a: { userId: string; prod: string; staging: string };
  b: { userId: string; projectId: string };
  ids: Record<"cart" | "search" | "auth" | "staging" | "weird", string>;
  eventIds: { cart: string[] };
};
let w: World;

const incidentParams = (over: Partial<IncidentListParams> = {}): IncidentListParams => ({ ...DEFAULT_INCIDENT_PARAMS, ...over });
const eventParams = (over: Partial<EventListParams> = {}): EventListParams => ({ ...DEFAULT_EVENT_PARAMS, ...over });

beforeAll(async () => {
  admin = adminPool(port);
  service = servicePool(port, 10);

  const a = await createUserAndProject(admin, "prod");
  const stagingProject = (
    await admin.query<{ id: string }>(
      "insert into public.projects (owner_id, name, environment) values ($1, $2, 'staging') returning id",
      [a.userId, `staging-${crypto.randomUUID().slice(0, 8)}`],
    )
  ).rows[0].id;
  const b = await createUserAndProject(admin, "other");

  const cart = await ingestEvents(service, a.projectId, [
    buildEvent({ message: "Cart crash: undefined items", level: "fatal", severity: "critical", endpoint: "/api/cart", event_type: "TypeError", occurred_at: ago(30 * MIN), stack_trace: "TypeError: x\n    at f (/app/cart.ts:1:1)", attributes: { userId: 7 } }),
    buildEvent({ message: "Cart crash: undefined items", level: "fatal", severity: "critical", endpoint: "/api/cart", event_type: "TypeError", occurred_at: ago(20 * MIN) }),
    buildEvent({ message: "Cart crash: undefined items", level: "fatal", severity: "critical", endpoint: "/api/cart", event_type: "TypeError", occurred_at: ago(10 * MIN) }),
  ]);
  const search = await ingestEvents(service, a.projectId, [
    buildEvent({ message: "Search is slow", level: "info", severity: "low", endpoint: "/search", event_type: "Timeout", occurred_at: ago(3 * DAY) }),
  ]);
  const auth = await ingestEvents(service, a.projectId, [
    buildEvent({ message: "Auth token expired", level: "warning", severity: "medium", endpoint: "/account", event_type: "AuthError", occurred_at: ago(20 * DAY) }),
  ]);
  const stg = await ingestEvents(service, stagingProject, [
    buildEvent({ message: "Staging only failure", level: "error", severity: "high", endpoint: "/staging", occurred_at: ago(2 * 60 * MIN) }),
  ]);
  // Characters that are special to LIKE and to PostgREST filter syntax.
  const weird = await ingestEvents(service, a.projectId, [
    buildEvent({ message: '100% sure_thing, (really) "quoted" \\ end', level: "error", severity: "high", endpoint: "/weird", occurred_at: ago(5 * MIN) }),
  ]);
  await ingestEvents(service, b.projectId, [buildEvent({ message: "B private failure", endpoint: "/b/secret", occurred_at: ago(MIN) })]);

  // Move the incidents' status into the states the tests rely on (through the guarded path, as a user).
  const rpc = createPgRpc(admin, a.userId);
  await changeIncidentStatus(rpc, { incidentId: search[0].incident_id, to: "resolved", expected: "open" });
  await changeIncidentStatus(rpc, { incidentId: auth[0].incident_id, to: "investigating", expected: "open" });

  const cartEvents = (await admin.query<{ id: string }>("select e.id from public.events e join public.incident_events ie on ie.event_id = e.id where ie.incident_id = $1 order by e.occurred_at", [cart[0].incident_id])).rows.map((r) => r.id);

  w = {
    a: { userId: a.userId, prod: a.projectId, staging: stagingProject },
    b: { userId: b.userId, projectId: b.projectId },
    ids: { cart: cart[0].incident_id, search: search[0].incident_id, auth: auth[0].incident_id, staging: stg[0].incident_id, weird: weird[0].incident_id },
    eventIds: { cart: cartEvents },
  };
});

afterAll(async () => {
  await admin.end();
  await service.end();
});

const asA = () => createPgRpc(admin, w.a.userId);
const asB = () => createPgRpc(admin, w.b.userId);

describe("incident list: filtering", () => {
  it("lists every incident the user owns, newest activity first, with total", async () => {
    const page = await fetchIncidentList(asA(), incidentParams(), NOW);
    expect(page.total).toBe(5);
    expect(page.items[0].title).toBe('100% sure_thing, (really) "quoted" \\ end'.slice(0, 200));
    expect(page.items.map((i) => i.id)).not.toContain(undefined);
    expect(page.items.find((i) => i.id === w.ids.cart)).toMatchObject({ severity: "critical", status: "open", occurrenceCount: 3, endpoint: "/api/cart", projectName: expect.stringContaining("prod") });
  });

  it("filters by status", async () => {
    const page = await fetchIncidentList(asA(), incidentParams({ status: "resolved" }), NOW);
    expect(page.items.map((i) => i.id)).toEqual([w.ids.search]);
    expect((await fetchIncidentList(asA(), incidentParams({ status: "investigating" }), NOW)).items.map((i) => i.id)).toEqual([w.ids.auth]);
  });

  it("filters by severity", async () => {
    expect((await fetchIncidentList(asA(), incidentParams({ severity: "critical" }), NOW)).items.map((i) => i.id)).toEqual([w.ids.cart]);
    expect((await fetchIncidentList(asA(), incidentParams({ severity: "high" }), NOW)).total).toBe(2);
  });

  it("filters by environment (a project property)", async () => {
    const staging = await fetchIncidentList(asA(), incidentParams({ env: "staging" }), NOW);
    expect(staging.items.map((i) => i.id)).toEqual([w.ids.staging]);
    expect(staging.items[0].environment).toBe("staging");
    expect((await fetchIncidentList(asA(), incidentParams({ env: "production" }), NOW)).total).toBe(4);
    expect((await fetchIncidentList(asA(), incidentParams({ env: "development" }), NOW)).total).toBe(0);
  });

  it("filters by project", async () => {
    expect((await fetchIncidentList(asA(), incidentParams({ project: w.a.staging }), NOW)).total).toBe(1);
  });

  it("filters by when the incident was last seen", async () => {
    expect((await fetchIncidentList(asA(), incidentParams({ since: "1h" }), NOW)).total).toBe(2); // cart, weird (staging is 2h old)
    expect((await fetchIncidentList(asA(), incidentParams({ since: "24h" }), NOW)).total).toBe(3);
    expect((await fetchIncidentList(asA(), incidentParams({ since: "7d" }), NOW)).total).toBe(4);
    expect((await fetchIncidentList(asA(), incidentParams({ since: "30d" }), NOW)).total).toBe(5);
  });

  it("searches title and endpoint, case-insensitively", async () => {
    expect((await fetchIncidentList(asA(), incidentParams({ q: "CART" }), NOW)).items.map((i) => i.id)).toEqual([w.ids.cart]);
    expect((await fetchIncidentList(asA(), incidentParams({ q: "/account" }), NOW)).items.map((i) => i.id)).toEqual([w.ids.auth]);
    expect((await fetchIncidentList(asA(), incidentParams({ q: "nothing matches this" }), NOW)).total).toBe(0);
  });

  it("treats LIKE wildcards and filter-syntax characters in the search as literal text", async () => {
    // "%" and "_" must not act as wildcards, and commas/parens/quotes must not alter the query.
    expect((await fetchIncidentList(asA(), incidentParams({ q: "100%" }), NOW)).items.map((i) => i.id)).toEqual([w.ids.weird]);
    expect((await fetchIncidentList(asA(), incidentParams({ q: "sure_thing" }), NOW)).items.map((i) => i.id)).toEqual([w.ids.weird]);
    expect((await fetchIncidentList(asA(), incidentParams({ q: "sure_thin" }), NOW)).total).toBe(1);
    expect((await fetchIncidentList(asA(), incidentParams({ q: "sureXthing" }), NOW)).total).toBe(0); // "_" is not a wildcard
    expect((await fetchIncidentList(asA(), incidentParams({ q: "%" }), NOW)).items.map((i) => i.id)).toEqual([w.ids.weird]); // only titles that contain a literal %
    expect((await fetchIncidentList(asA(), incidentParams({ q: ", (really)" }), NOW)).total).toBe(1);
    expect((await fetchIncidentList(asA(), incidentParams({ q: '"quoted"' }), NOW)).total).toBe(1);
    expect((await fetchIncidentList(asA(), incidentParams({ q: "\\" }), NOW)).total).toBe(1);
    expect((await fetchIncidentList(asA(), incidentParams({ q: "x'); drop table incidents; --" }), NOW)).total).toBe(0);
    expect((await fetchIncidentCounts(asA(), { project: null })).total).toBe(5); // still intact
  });

  it("combines filters", async () => {
    const page = await fetchIncidentList(asA(), incidentParams({ status: "open", severity: "high", env: "production" }), NOW);
    expect(page.items.map((i) => i.id)).toEqual([w.ids.weird]);
  });
});

describe("incident list: sorting and pagination", () => {
  it("sorts by last seen, newest first by default and oldest first when ascending", async () => {
    const desc = await fetchIncidentList(asA(), incidentParams({ sort: "last_seen", dir: "desc" }), NOW);
    expect(desc.items[0].id).toBe(w.ids.weird);
    expect(desc.items.at(-1)?.id).toBe(w.ids.auth);
    const asc = await fetchIncidentList(asA(), incidentParams({ sort: "last_seen", dir: "asc" }), NOW);
    expect(asc.items.map((i) => i.id)).toEqual([...desc.items].reverse().map((i) => i.id));
  });

  it("sorts by title", async () => {
    const asc = await fetchIncidentList(asA(), incidentParams({ sort: "title", dir: "asc" }), NOW);
    const titles = asc.items.map((i) => i.title);
    expect(titles[0]).toMatch(/^100%/); // digits sort before letters
    expect(titles.slice(1)).toEqual(["Auth token expired", "Cart crash: undefined items", "Search is slow", "Staging only failure"]);
    const desc = await fetchIncidentList(asA(), incidentParams({ sort: "title", dir: "desc" }), NOW);
    expect(desc.items[0].title).toBe("Staging only failure");
  });

  it("sorts by severity (critical first) and by occurrences", async () => {
    const bySeverity = await fetchIncidentList(asA(), incidentParams({ sort: "severity", dir: "desc" }), NOW);
    expect(bySeverity.items[0].severity).toBe("critical");
    expect(bySeverity.items.at(-1)?.severity).toBe("low");
    const byOccurrences = await fetchIncidentList(asA(), incidentParams({ sort: "occurrences", dir: "desc" }), NOW);
    expect(byOccurrences.items[0].id).toBe(w.ids.cart);
    const asc = await fetchIncidentList(asA(), incidentParams({ sort: "occurrences", dir: "asc" }), NOW);
    expect(asc.items.at(-1)?.id).toBe(w.ids.cart);
  });

  it("sorts by status order (open < investigating < resolved)", async () => {
    const page = await fetchIncidentList(asA(), incidentParams({ sort: "status", dir: "desc" }), NOW);
    expect(page.items[0].status).toBe("resolved");
  });

  it("rejects an unknown sort column at the database, so it can never reach SQL", async () => {
    const { error } = await asA().rpc("list_incidents", { p_sort: "title; drop table incidents", p_dir: "asc" });
    expect(error?.code).toBe("22023");
    const bad = await asA().rpc("list_incidents", { p_sort: "title", p_dir: "sideways" });
    expect(bad.error?.code).toBe("22023");
  });

  it("paginates with accurate totals", async () => {
    // Use a user with many incidents.
    const bulk = await createUserAndProject(admin, "bulk");
    await ingestEvents(service, bulk.projectId, Array.from({ length: 45 }, (_, i) => buildEvent({ message: `Bulk failure number ${i} ${"x".repeat(i)}`, occurred_at: ago(i * MIN) })));
    const db = createPgRpc(admin, bulk.userId);

    const first = await fetchIncidentList(db, incidentParams(), NOW);
    expect(first).toMatchObject({ total: 45, page: 1, pageCount: 3, pageSize: 20 });
    expect(first.items).toHaveLength(20);

    const third = await fetchIncidentList(db, incidentParams({ page: 3 }), NOW);
    expect(third.items).toHaveLength(5);
    const ids = new Set([...first.items, ...(await fetchIncidentList(db, incidentParams({ page: 2 }), NOW)).items, ...third.items].map((i) => i.id));
    expect(ids.size).toBe(45); // no overlap, no gaps
  });

  it("returns the last real page when the requested page is past the end", async () => {
    const bulk = await createUserAndProject(admin, "bulk2");
    await ingestEvents(service, bulk.projectId, Array.from({ length: 25 }, (_, i) => buildEvent({ message: `Overflow ${i} ${"y".repeat(i)}` })));
    const page = await fetchIncidentList(createPgRpc(admin, bulk.userId), incidentParams({ page: 99 }), NOW);
    expect(page).toMatchObject({ page: 2, pageCount: 2, total: 25 });
    expect(page.items).toHaveLength(5);
  });

  it("returns an empty first page (not an error) when nothing matches", async () => {
    const page = await fetchIncidentList(asA(), incidentParams({ q: "zzzz", page: 4 }), NOW);
    expect(page).toMatchObject({ items: [], total: 0, page: 1, pageCount: 1 });
  });
});

describe("incident counts", () => {
  it("counts unresolved, critical, and recently resolved", async () => {
    // unresolved: cart(open) auth(investigating) weird(open) staging(open); critical: cart; resolved just now: search
    expect(await fetchIncidentCounts(asA(), { project: null })).toEqual({ unresolved: 4, critical: 1, recentlyResolved: 1, total: 5 });
  });

  it("scopes by project and environment", async () => {
    expect((await fetchIncidentCounts(asA(), { project: w.a.staging })).total).toBe(1);
    expect((await fetchIncidentCounts(asA(), { project: null, environment: "staging" })).unresolved).toBe(1);
  });

  it("reports unresolved per project for the sidebar badge", async () => {
    const map = await fetchUnresolvedByProject(asA());
    expect(map[w.a.prod]).toBe(3);
    expect(map[w.a.staging]).toBe(1);
  });
});

describe("incident detail", () => {
  it("loads the incident with project context", async () => {
    const incident = await fetchIncident(asA(), w.ids.cart);
    expect(incident).toMatchObject({ id: w.ids.cart, title: "Cart crash: undefined items", severity: "critical", status: "open", occurrenceCount: 3, endpoint: "/api/cart", resolvedAt: null });
    expect(incident?.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns null for malformed ids without querying", async () => {
    expect(await fetchIncident(asA(), "not-a-uuid")).toBeNull();
    expect(await fetchIncident(asA(), "' or 1=1 --")).toBeNull();
  });

  it("returns null for an id that does not exist", async () => {
    expect(await fetchIncident(asA(), "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("builds an occurrences histogram that accounts for every event", async () => {
    const buckets = await fetchHistogram(asA(), w.ids.cart, 12);
    expect(buckets).toHaveLength(12);
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(3);
    expect(Date.parse(buckets[0].start)).toBeLessThan(Date.parse(buckets[11].end));
  });
});

describe("unauthorized access: another user's data is invisible and immutable", () => {
  it("hides incidents from lists, counts, and detail", async () => {
    const list = await fetchIncidentList(asB(), incidentParams(), NOW);
    expect(list.items.map((i) => i.title)).toEqual(["B private failure"]);
    expect(await fetchIncident(asB(), w.ids.cart)).toBeNull();
    expect(await fetchIncident(asA(), w.ids.cart)).not.toBeNull();
    expect((await fetchIncidentCounts(asB(), { project: w.a.prod })).total).toBe(0);
    // Asking for A's project explicitly still returns nothing for B.
    expect((await fetchIncidentList(asB(), incidentParams({ project: w.a.prod }), NOW)).total).toBe(0);
  });

  it("hides events, event details, activity, histograms, and filter options", async () => {
    expect((await fetchEventPage(asB(), eventParams({ project: w.a.prod }), {}, NOW)).total).toBe(0);
    expect(await fetchEventDetail(asB(), w.eventIds.cart[0])).toBeNull();
    expect(await fetchActivity(asB(), w.ids.search)).toEqual([]);
    expect((await fetchHistogram(asB(), w.ids.cart)).reduce((s, b) => s + b.count, 0)).toBe(0);
    expect(await fetchEventFilterOptions(asB(), w.a.prod)).toEqual({ eventTypes: [], endpoints: [] });
  });

  it("cannot change another user's incident: it behaves exactly like a missing one", async () => {
    const result = await changeIncidentStatus(asB(), { incidentId: w.ids.cart, to: "resolved", expected: "open" });
    expect(result).toEqual({ result: "not_found" });
    expect((await fetchIncident(asA(), w.ids.cart))?.status).toBe("open");
  });

  it("cannot start an AI analysis on another user's incident", async () => {
    const { data } = await asB().rpc("start_analysis", { p_incident: w.ids.cart, p_model: "m" });
    expect(data).toEqual({ result: "not_found" });
  });

  it("gives signed-out (anon) callers no access to any function", async () => {
    const anon = createPgRpc(admin, null);
    for (const [fn, args] of [
      ["list_incidents", {}],
      ["get_incident", { p_id: w.ids.cart }],
      ["list_events", {}],
      ["dashboard_overview", { p_project: null, p_from: ago(DAY), p_to: NOW.toISOString(), p_buckets: 4 }],
      ["change_incident_status", { p_id: w.ids.cart, p_to: "resolved", p_expected: "open" }],
    ] as const) {
      const { error } = await anon.rpc(fn, args);
      expect(error?.message, fn).toMatch(/permission denied/);
    }
  });
});

describe("status transitions", () => {
  async function freshIncident() {
    const p = await createUserAndProject(admin, "status");
    const [r] = await ingestEvents(service, p.projectId, [buildEvent({ message: `Status test ${crypto.randomUUID()}` })]);
    return { ...p, incidentId: r.incident_id, db: createPgRpc(admin, p.userId) };
  }

  it("acknowledges an open incident and persists it", async () => {
    const f = await freshIncident();
    expect(await changeIncidentStatus(f.db, { incidentId: f.incidentId, to: "investigating", expected: "open" })).toMatchObject({ result: "ok", status: "investigating" });
    expect((await fetchIncident(f.db, f.incidentId))?.status).toBe("investigating");
  });

  it("resolves (setting resolved_at) and reopens (clearing it)", async () => {
    const f = await freshIncident();
    const resolved = await changeIncidentStatus(f.db, { incidentId: f.incidentId, to: "resolved", expected: "open" });
    expect(resolved).toMatchObject({ result: "ok", status: "resolved" });
    expect((await fetchIncident(f.db, f.incidentId))?.resolvedAt).not.toBeNull();
    expect((await fetchIncidentCounts(f.db, { project: null })).recentlyResolved).toBe(1);

    await changeIncidentStatus(f.db, { incidentId: f.incidentId, to: "open", expected: "resolved" });
    const reopened = await fetchIncident(f.db, f.incidentId);
    expect(reopened).toMatchObject({ status: "open", resolvedAt: null });
  });

  it("reports a conflict, without changing anything, when the status moved underneath the caller", async () => {
    const f = await freshIncident();
    await changeIncidentStatus(f.db, { incidentId: f.incidentId, to: "resolved", expected: "open" });
    // A stale tab still thinks it is "open".
    const stale = await changeIncidentStatus(f.db, { incidentId: f.incidentId, to: "investigating", expected: "open" });
    expect(stale).toEqual({ result: "conflict", status: "resolved" });
    expect((await fetchIncident(f.db, f.incidentId))?.status).toBe("resolved");
  });

  it("applies exactly one of two concurrent identical changes", async () => {
    const f = await freshIncident();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => changeIncidentStatus(createPgRpc(admin, f.userId), { incidentId: f.incidentId, to: "resolved", expected: "open" })),
    );
    expect(results.filter((r) => r.result === "ok")).toHaveLength(1);
    expect(results.filter((r) => r.result === "conflict")).toHaveLength(7);
    expect((await fetchActivity(f.db, f.incidentId)).filter((a) => a.toStatus === "resolved")).toHaveLength(1);
  });

  it.each([
    ["resolved", "investigating"],
    ["investigating", "open"],
    ["open", "open"],
  ] as const)("rejects the invalid transition %s -> %s in the application", async (from, to) => {
    const f = await freshIncident();
    const result = await changeIncidentStatus(f.db, { incidentId: f.incidentId, to, expected: from });
    expect(result.result).toBe("invalid_transition");
  });

  it("also rejects invalid transitions inside the database, even if the application is bypassed", async () => {
    const f = await freshIncident();
    await changeIncidentStatus(f.db, { incidentId: f.incidentId, to: "resolved", expected: "open" });
    const { error } = await f.db.rpc("change_incident_status", { p_id: f.incidentId, p_to: "investigating", p_expected: "resolved" });
    expect(error?.code).toBe("23514");
    expect((await fetchIncident(f.db, f.incidentId))?.status).toBe("resolved");
  });

  it("rejects malformed input without touching the database", async () => {
    const f = await freshIncident();
    for (const input of [
      { incidentId: "nope", to: "resolved", expected: "open" },
      { incidentId: f.incidentId, to: "closed", expected: "open" },
      { incidentId: f.incidentId, to: "resolved", expected: "bogus" },
      { incidentId: null, to: null, expected: null },
    ]) {
      expect((await changeIncidentStatus(f.db, input)).result).toBe("invalid_input");
    }
  });

  it("logs every change with who made it, and logs recurrence-driven reopening as the system", async () => {
    const f = await freshIncident();
    const message = `Recurring ${crypto.randomUUID()}`;
    const [first] = await ingestEvents(service, f.projectId, [buildEvent({ message, occurred_at: ago(5 * MIN) })]);
    await changeIncidentStatus(f.db, { incidentId: first.incident_id, to: "investigating", expected: "open" });
    await changeIncidentStatus(f.db, { incidentId: first.incident_id, to: "resolved", expected: "investigating" });
    // The same error happens again: ingestion reopens the incident.
    await ingestEvents(service, f.projectId, [buildEvent({ message, occurred_at: new Date().toISOString() })]);

    const log = await fetchActivity(f.db, first.incident_id);
    expect(log.map((a) => `${a.fromStatus}->${a.toStatus}:${a.actor}`)).toEqual([
      "resolved->open:system",
      "investigating->resolved:you",
      "open->investigating:you",
    ]);
    expect((await fetchIncident(f.db, first.incident_id))?.status).toBe("open");
  });

  it("does not log anything when the status is unchanged", async () => {
    const f = await freshIncident();
    await ingestEvents(service, f.projectId, [buildEvent({ message: "no-op", occurred_at: ago(MIN) })]);
    expect(await fetchActivity(f.db, f.incidentId)).toEqual([]);
  });
});

describe("events", () => {
  it("lists the user's events newest first with incident links, without heavy payloads", async () => {
    const page = await fetchEventPage(asA(), eventParams(), {}, NOW);
    expect(page.total).toBe(7);
    expect(page.items[0].occurredAt >= page.items[1].occurredAt).toBe(true);
    const cartEvent = page.items.find((e) => e.id === w.eventIds.cart[0]);
    expect(cartEvent).toMatchObject({ incidentId: w.ids.cart, endpoint: "/api/cart", eventType: "TypeError", level: "fatal" });
    expect(Object.keys(cartEvent ?? {})).not.toContain("stackTrace");
  });

  it("filters by level, type, endpoint, project, since, and search", async () => {
    expect((await fetchEventPage(asA(), eventParams({ level: "fatal" }), {}, NOW)).total).toBe(3);
    expect((await fetchEventPage(asA(), eventParams({ type: "Timeout" }), {}, NOW)).total).toBe(1);
    expect((await fetchEventPage(asA(), eventParams({ endpoint: "api/ca" }), {}, NOW)).total).toBe(3);
    expect((await fetchEventPage(asA(), eventParams({ project: w.a.staging }), {}, NOW)).total).toBe(1);
    expect((await fetchEventPage(asA(), eventParams({ since: "1h" }), {}, NOW)).total).toBe(4);
    expect((await fetchEventPage(asA(), eventParams({ q: "slow" }), {}, NOW)).total).toBe(1);
    expect((await fetchEventPage(asA(), eventParams({ q: "100%" }), {}, NOW)).total).toBe(1);
    expect((await fetchEventPage(asA(), eventParams({ q: "sureXthing" }), {}, NOW)).total).toBe(0);
  });

  it("scopes to one incident and paginates", async () => {
    const page = await fetchEventPage(asA(), eventParams(), { incidentId: w.ids.cart, pageSize: 2 }, NOW);
    expect(page).toMatchObject({ total: 3, pageCount: 2, pageSize: 2 });
    expect(page.items).toHaveLength(2);
    const second = await fetchEventPage(asA(), eventParams({ page: 2 }), { incidentId: w.ids.cart, pageSize: 2 }, NOW);
    expect(second.items).toHaveLength(1);
    expect(new Set([...page.items, ...second.items].map((e) => e.id)).size).toBe(3);
  });

  it("loads full detail (stack trace and attributes) on demand", async () => {
    const detail = await fetchEventDetail(asA(), w.eventIds.cart[0]);
    expect(detail).toMatchObject({ stackTrace: expect.stringContaining("at f"), attributes: { userId: 7 }, incidentId: w.ids.cart, message: "Cart crash: undefined items" });
  });

  it("returns null for malformed or unknown event ids", async () => {
    expect(await fetchEventDetail(asA(), "x")).toBeNull();
    expect(await fetchEventDetail(asA(), "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("offers filter options ordered by frequency", async () => {
    const options = await fetchEventFilterOptions(asA(), null);
    expect(options.eventTypes[0]).toBe("TypeError"); // 3 events
    expect(options.endpoints[0]).toBe("/api/cart");
    expect(options.endpoints).toContain("/staging");
    expect((await fetchEventFilterOptions(asA(), w.a.staging)).endpoints).toEqual(["/staging"]);
  });
});

describe("dashboard overview (real aggregates)", () => {
  it("computes KPIs, series and severity mix from the user's data only", async () => {
    const o = await fetchDashboardOverview(asA(), { project: null, range: "24h" }, NOW);
    // In the last 24h: cart x3 (fatal), weird (error), staging (error) = 5 events, all error-level.
    expect(o.kpis.find((k) => k.id === "events")?.value).toBe(5);
    expect(o.kpis.find((k) => k.id === "errorRate")?.value).toBe(100);
    expect(o.kpis.find((k) => k.id === "unresolved")?.value).toBe(3);
    expect(o.kpis.find((k) => k.id === "endpoints")?.value).toBe(3);
    expect(o.series).toHaveLength(24);
    expect(o.series.reduce((s, p) => s + p.events, 0)).toBe(5);
    expect(o.severityBreakdown).toEqual([
      { severity: "critical", count: 1 },
      { severity: "high", count: 2 },
      { severity: "medium", count: 0 },
      { severity: "low", count: 0 },
    ]);
    expect(o.counts.unresolved).toBe(4);
  });

  it("counts only error and fatal events in the error rate", async () => {
    const o = await fetchDashboardOverview(asA(), { project: null, range: "7d" }, NOW);
    // 7d: + "Search slow" (info). 6 events, 5 errors.
    expect(o.kpis.find((k) => k.id === "events")?.value).toBe(6);
    expect(o.kpis.find((k) => k.id === "errorRate")?.value).toBe(83.3);
  });

  it("scopes to a project", async () => {
    const o = await fetchDashboardOverview(asA(), { project: { id: w.a.staging, name: "s", workspace: "", environment: "staging" }, range: "24h" }, NOW);
    expect(o.kpis.find((k) => k.id === "events")?.value).toBe(1);
  });

  it("reports a trend against the previous period, or null with no baseline", async () => {
    const o = await fetchDashboardOverview(asA(), { project: null, range: "7d" }, NOW);
    // Previous 7 days (7-14d ago) contain no events: no baseline.
    expect(o.kpis.find((k) => k.id === "events")?.changePercent).toBeNull();
    // Last hour: 4 events; the hour before it: 1 (staging). (4 - 1) / 1 = +300%.
    const hour = await fetchDashboardOverview(asA(), { project: null, range: "1h" }, NOW);
    expect(hour.kpis.find((k) => k.id === "events")?.changePercent).toBe(300);
  });

  it("returns zeros, not errors, for a user with no data", async () => {
    const empty = await createUserAndProject(admin, "empty");
    const o = await fetchDashboardOverview(createPgRpc(admin, empty.userId), { project: null, range: "24h" }, NOW);
    expect(o.kpis.map((k) => k.value)).toEqual([0, 0, 0, 0]);
    expect(o.series.every((p) => p.events === 0)).toBe(true);
    expect(o.series).toHaveLength(24);
  });

  it("never includes another user's events", async () => {
    const o = await fetchDashboardOverview(asB(), { project: null, range: "24h" }, NOW);
    expect(o.kpis.find((k) => k.id === "events")?.value).toBe(1);
  });
});

describe("incident endpoint maintenance", () => {
  it("shows the endpoint of the most recent event that named one", async () => {
    const p = await createUserAndProject(admin, "endpoint");
    const message = `Endpoint drift ${crypto.randomUUID()}`;
    await ingestEvents(service, p.projectId, [buildEvent({ message, endpoint: "/old", occurred_at: ago(10 * MIN) })]);
    await ingestEvents(service, p.projectId, [buildEvent({ message, endpoint: "/new", occurred_at: ago(5 * MIN) })]);
    await ingestEvents(service, p.projectId, [buildEvent({ message, endpoint: null, occurred_at: ago(MIN) })]);
    await ingestEvents(service, p.projectId, [buildEvent({ message, endpoint: "/ancient", occurred_at: ago(60 * MIN) })]); // older: must not win
    const page = await fetchIncidentList(createPgRpc(admin, p.userId), incidentParams(), NOW);
    expect(page.items[0].endpoint).toBe("/new");
  });
});
