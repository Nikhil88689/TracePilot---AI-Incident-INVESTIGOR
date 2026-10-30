/**
 * Dashboard metrics and the demo scenario against a REAL Postgres, as real signed-in users (RLS active).
 * Nothing is mocked except the AI provider in the walkthrough test.
 */
import Anthropic from "@anthropic-ai/sdk";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { investigateIncident, type AiClient } from "../../src/lib/ai/investigate";
import { DEMO, DEMO_TOTAL_EVENTS } from "../../src/lib/demo/scenario";
import { removeDemo, seedDemo } from "../../src/lib/demo/service";
import { DEFAULT_EVENT_PARAMS, DEFAULT_INCIDENT_PARAMS } from "../../src/lib/incidents/params";
import {
  changeIncidentStatus,
  fetchActivity,
  fetchDashboardOverview,
  fetchDeployments,
  fetchEventFilterOptions,
  fetchEventPage,
  fetchIncident,
  fetchIncidentCounts,
  fetchIncidentList,
  fetchLatestAnalysis,
  setAnalysisStep,
} from "../../src/lib/incidents/queries";
import { adminPool, asAnon, asUser, buildEvent, createUserAndProject, ingestEvents, servicePool } from "./pg-harness";
import { createPgRpc } from "./pg-rpc";

const port = Number(process.env.TP_TEST_PG_PORT);
let admin: pg.Pool;
let service: pg.Pool;

/** The demo clock. Any fixed instant works: every timestamp is defined relative to it. */
const ANCHOR = new Date("2026-06-01T12:00:00.000Z");
/** Dashboard "now": one second after the demo clock (a viewer opens the dashboard just after seeding). */
const NOW = new Date(ANCHOR.getTime() + 1_000);
const MIN = 60_000;

beforeAll(() => {
  admin = adminPool(port);
  service = servicePool(port, 8);
});
afterAll(async () => {
  await admin.end();
  await service.end();
});

const newUser = async (name = "real") => {
  const u = await createUserAndProject(admin, name);
  return { ...u, db: createPgRpc(admin, u.userId) };
};
const count = async (sql: string, params: unknown[]) => Number((await admin.query(sql, params)).rows[0].n);
const demoOf = async (u: Awaited<ReturnType<typeof newUser>>, opts: { reset?: boolean } = {}) => {
  const r = await seedDemo(u.db, { now: ANCHOR, ...opts });
  if (!r.ok) throw new Error(`seed failed: ${r.reason}`);
  return r;
};
const kpi = (o: Awaited<ReturnType<typeof fetchDashboardOverview>>, id: string) => o.kpis.find((k) => k.id === id)!;

describe("demo seeding", () => {
  it("creates one simulated project matching the documented scenario exactly", async () => {
    const u = await newUser();
    const r = await demoOf(u);
    expect(r.created).toBe(true);

    const [project] = (await admin.query("select name, environment, is_demo, owner_id from public.projects where id = $1", [r.projectId])).rows;
    expect(project).toMatchObject({ name: DEMO.projectName, environment: "development", is_demo: true, owner_id: u.userId });

    expect(await count("select count(*) n from public.events where project_id = $1", [r.projectId])).toBe(DEMO_TOTAL_EVENTS);
    expect(await count("select count(*) n from public.events where project_id = $1 and level = 'error'", [r.projectId])).toBe(DEMO.counts.incidentEvents);
    expect(await count("select count(*) n from public.events where project_id = $1 and level = 'info'", [r.projectId])).toBe(DEMO.counts.traffic);
    expect(await count("select count(*) n from public.deployments where project_id = $1", [r.projectId])).toBe(DEMO.counts.deployments);
    expect(await count("select count(*) n from public.incidents where project_id = $1", [r.projectId])).toBe(1);
    expect(await count("select count(*) n from public.analyses a join public.incidents i on i.id = a.incident_id where i.project_id = $1", [r.projectId])).toBe(1);
  });

  it("tells a coherent story: deploy, burst on /api/checkout with DB timeouts, rollback, recovery, one incident", async () => {
    const u = await newUser();
    const { projectId } = await demoOf(u);
    const minutesBeforeAnchor = (iso: Date) => Math.round((ANCHOR.getTime() - iso.getTime()) / MIN);

    const deployments = (await admin.query("select version, deployed_at, source from public.deployments where project_id = $1 order by deployed_at", [projectId])).rows;
    expect(deployments.map((d) => [d.version, minutesBeforeAnchor(d.deployed_at), d.source])).toEqual([
      [DEMO.versions.bad, DEMO.minutesAgo.deployBad, "demo"],
      [DEMO.versions.good, DEMO.minutesAgo.rollback, "demo"],
    ]);

    const [incident] = (await admin.query("select * from public.incidents where project_id = $1", [projectId])).rows;
    expect(incident).toMatchObject({ severity: "critical", status: "open", occurrence_count: DEMO.counts.incidentEvents, endpoint: DEMO.endpoint });
    expect(incident.title).toContain("HTTP 500 on POST /api/checkout");
    expect(minutesBeforeAnchor(incident.first_seen_at)).toBe(DEMO.minutesAgo.burstStart);

    const burst = (await admin.query(
      "select e.event_type, e.occurred_at, e.endpoint, e.stack_trace, e.attributes from public.events e join public.incident_events ie on ie.event_id = e.id where ie.incident_id = $1 order by e.occurred_at",
      [incident.id],
    )).rows;
    expect(burst).toHaveLength(DEMO.counts.incidentEvents);
    expect(burst.filter((e) => e.event_type === "HttpError")).toHaveLength(DEMO.counts.http500);
    expect(burst.filter((e) => e.event_type === "DatabaseTimeoutError")).toHaveLength(DEMO.counts.dbTimeouts);
    expect(burst.every((e) => e.endpoint === DEMO.endpoint && e.stack_trace.includes("reserveInventory"))).toBe(true);
    expect(burst.every((e) => e.attributes.simulated === true && e.attributes.release === DEMO.versions.bad)).toBe(true);
    // The burst starts after the bad deploy and stops before the rollback (a few seconds of lag).
    expect(burst[0].occurred_at.getTime()).toBeGreaterThan(deployments[0].deployed_at.getTime());
    expect(burst.at(-1).occurred_at.getTime()).toBeLessThan(deployments[1].deployed_at.getTime());
    expect(Date.parse(incident.last_seen_at)).toBe(burst.at(-1).occurred_at.getTime());

    // Baseline traffic is normal: info level, on the previous release before the deploy and after the rollback.
    const releases = (await admin.query("select distinct attributes ->> 'release' r from public.events where project_id = $1 and level = 'info' and occurred_at < $2", [projectId, new Date(ANCHOR.getTime() - DEMO.minutesAgo.deployBad * MIN)])).rows;
    expect(releases).toEqual([{ r: DEMO.versions.good }]);
    // Baseline logs are deliberately not grouped into incidents.
    expect(await count("select count(*) n from public.events e where e.project_id = $1 and level = 'info' and exists (select 1 from public.incident_events ie where ie.event_id = e.id)", [projectId])).toBe(0);
  });

  it("is idempotent: seeding again returns the same project and changes nothing, even with a different clock", async () => {
    const u = await newUser();
    const first = await demoOf(u);
    const snapshot = async () => (await admin.query("select md5(string_agg(id::text || occurred_at::text || message, ',' order by id)) h, count(*) n from public.events where project_id = $1", [first.projectId])).rows[0];
    const before = await snapshot();

    const again = await seedDemo(u.db, { now: ANCHOR });
    const later = await seedDemo(u.db, { now: new Date(ANCHOR.getTime() + 5 * 86_400_000) });
    expect(again).toEqual({ ok: true, projectId: first.projectId, created: false });
    expect(later).toEqual({ ok: true, projectId: first.projectId, created: false });
    expect(await snapshot()).toEqual(before);
    expect(await count("select count(*) n from public.projects where owner_id = $1 and is_demo", [u.userId])).toBe(1);
    expect(await count("select count(*) n from public.incidents where project_id = $1", [first.projectId])).toBe(1);
  });

  it("creates exactly one demo project when seeded concurrently", async () => {
    const u = await newUser();
    const results = await Promise.all(Array.from({ length: 6 }, () => seedDemo(createPgRpc(admin, u.userId), { now: ANCHOR })));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => (r.ok ? r.projectId : ""))).size).toBe(1);
    expect(await count("select count(*) n from public.projects where owner_id = $1 and is_demo", [u.userId])).toBe(1);
    expect(await count("select count(*) n from public.events e join public.projects p on p.id = e.project_id where p.owner_id = $1 and p.is_demo", [u.userId])).toBe(DEMO_TOTAL_EVENTS);
  });

  it("is deterministic: the same demo clock gives identical data (relative to the clock) for different users", async () => {
    const a = await newUser("det-a");
    const b = await newUser("det-b");
    const ra = await demoOf(a);
    const rb = await demoOf(b);
    const shape = async (projectId: string) =>
      (await admin.query(
        `select external_event_id, event_type, level, message, endpoint, extract(epoch from (occurred_at - $2::timestamptz)) as offset_s, attributes::text as attrs
           from public.events where project_id = $1 order by external_event_id`,
        [projectId, ANCHOR],
      )).rows;
    expect(await shape(ra.projectId)).toEqual(await shape(rb.projectId));
    // IDs are scoped per project, so two users never collide.
    expect(ra.projectId).not.toBe(rb.projectId);
  });

  it("reset rebuilds from scratch against a new demo clock, with the same stable ids", async () => {
    const u = await newUser();
    const first = await demoOf(u);
    const incidentId = (await admin.query("select id from public.incidents where project_id = $1", [first.projectId])).rows[0].id;
    // The user "resolves" it, then resets.
    await changeIncidentStatus(u.db, { incidentId, to: "resolved", expected: "open" });

    const later = new Date(ANCHOR.getTime() + 3 * 86_400_000);
    const reset = await seedDemo(u.db, { reset: true, now: later });
    expect(reset).toEqual({ ok: true, projectId: first.projectId, created: true });
    expect((await admin.query("select status from public.incidents where project_id = $1", [first.projectId])).rows[0].status).toBe("open");
    expect(await count("select count(*) n from public.events where project_id = $1", [first.projectId])).toBe(DEMO_TOTAL_EVENTS);
    // Timestamps moved with the new clock.
    const newest = (await admin.query("select max(occurred_at) m from public.events where project_id = $1", [first.projectId])).rows[0].m as Date;
    expect(newest.getTime()).toBe(later.getTime());
  });

  it("removes only the demo project and its data", async () => {
    const u = await newUser();
    await ingestEvents(service, u.projectId, [buildEvent({ message: "real event" })]);
    const { projectId } = await demoOf(u);
    expect(await removeDemo(u.db)).toBe(true);
    expect(await count("select count(*) n from public.projects where id = $1", [projectId])).toBe(0);
    expect(await count("select count(*) n from public.events where project_id = $1", [projectId])).toBe(0);
    expect(await count("select count(*) n from public.deployments where project_id = $1", [projectId])).toBe(0);
    expect(await count("select count(*) n from public.events where project_id = $1", [u.projectId])).toBe(1); // real data intact
    expect(await removeDemo(u.db)).toBe(false); // nothing left to remove
  });
});

describe("demo consent and safety", () => {
  it("never touches the user's real projects or anyone else's data", async () => {
    const a = await newUser("real-a");
    const b = await newUser("real-b");
    await ingestEvents(service, a.projectId, [buildEvent({ message: "A real failure" }), buildEvent({ message: "A second failure" })]);
    await ingestEvents(service, b.projectId, [buildEvent({ message: "B real failure" })]);
    const fingerprint = async () =>
      (await admin.query(
        "select (select md5(string_agg(e.id::text || e.message, ',' order by e.id)) from public.events e where e.project_id = $1) a, (select md5(string_agg(e.id::text || e.message, ',' order by e.id)) from public.events e where e.project_id = $2) b, (select count(*) from public.projects where owner_id in ($3, $4)) projects",
        [a.projectId, b.projectId, a.userId, b.userId],
      )).rows[0];
    const before = await fingerprint();

    await demoOf(a);
    const after = await fingerprint();
    expect(after.a).toBe(before.a);
    expect(after.b).toBe(before.b);
    expect(Number(after.projects)).toBe(Number(before.projects) + 1); // exactly one new project, for A
    expect(await count("select count(*) n from public.projects where owner_id = $1 and is_demo", [b.userId])).toBe(0);
  });

  it("requires a signed-in user: anonymous callers cannot seed", async () => {
    const anon = createPgRpc(admin, null);
    const { error } = await anon.rpc("seed_demo_project", { p_anchor: ANCHOR.toISOString(), p_reset: false });
    expect(error?.message).toMatch(/permission denied/);
  });

  it("cannot be used to plant a demo project from the client: is_demo cannot be written directly", async () => {
    const u = await newUser();
    await expect(
      asUser(admin, u.userId, (c) => c.query("insert into public.projects (owner_id, name, environment, is_demo) values ($1, 'sneaky', 'production', true)", [u.userId])),
    ).rejects.toThrow(/permission denied/);
    await expect(asUser(admin, u.userId, (c) => c.query("update public.projects set is_demo = true where id = $1", [u.projectId]))).rejects.toThrow(/permission denied/);
    // Normal onboarding writes still work.
    const ok = await asUser(admin, u.userId, (c) => c.query("insert into public.projects (owner_id, name, environment) values ($1, 'legit', 'staging') returning id", [u.userId]));
    expect(ok.rowCount).toBe(1);
  });

  it("refuses to clobber a user's own project that already has the demo's name", async () => {
    const u = await newUser();
    await admin.query("insert into public.projects (owner_id, name, environment) values ($1, $2, 'production')", [u.userId, DEMO.projectName]);
    expect(await seedDemo(u.db, { now: ANCHOR })).toEqual({ ok: false, reason: "name_taken" });
    expect(await count("select count(*) n from public.projects where owner_id = $1 and is_demo", [u.userId])).toBe(0);
  });

  it("keeps a user's demo data invisible to other users", async () => {
    const owner = await newUser();
    const intruder = await newUser();
    const { projectId } = await demoOf(owner);
    const o = await fetchDashboardOverview(intruder.db, { project: { id: projectId, name: "x", workspace: "", environment: "development", isDemo: true }, range: "24h" }, NOW);
    expect(kpi(o, "events").value).toBe(0);
    expect(await fetchDeployments(intruder.db, { project: projectId, from: new Date(NOW.getTime() - 86_400_000), to: NOW })).toEqual([]);
  });
});

describe("demo data is never mixed into real totals", () => {
  it("excludes demo projects from 'all projects' dashboards, lists, counts, filters and deployments, but includes them when selected", async () => {
    const u = await newUser();
    await ingestEvents(service, u.projectId, [
      buildEvent({ message: "Real error", level: "error", severity: "high", endpoint: "/real", occurred_at: new Date(NOW.getTime() - 5 * MIN).toISOString() }),
    ]);
    const { projectId: demoId } = await demoOf(u);
    const demoProject = { id: demoId, name: DEMO.projectName, workspace: "", environment: "development", isDemo: true };

    // "All projects" = real data only.
    const all = await fetchDashboardOverview(u.db, { project: null, range: "24h" }, NOW);
    expect(kpi(all, "events").value).toBe(1);
    expect(kpi(all, "unresolved").value).toBe(1);
    expect(all.deployments).toEqual([]);
    expect((await fetchEventPage(u.db, { ...DEFAULT_EVENT_PARAMS, since: "24h" }, {}, NOW)).total).toBe(1);
    expect((await fetchIncidentList(u.db, DEFAULT_INCIDENT_PARAMS, NOW)).total).toBe(1);
    expect(await fetchIncidentCounts(u.db, { project: null })).toMatchObject({ unresolved: 1, critical: 0, total: 1 });
    expect((await fetchEventFilterOptions(u.db, null)).endpoints).toEqual(["/real"]);

    // Selecting the demo project shows the demo, and only the demo.
    const demo = await fetchDashboardOverview(u.db, { project: demoProject, range: "24h" }, NOW);
    expect(kpi(demo, "events").value).toBe(228);
    expect(demo.deployments).toHaveLength(2);
    expect((await fetchIncidentList(u.db, { ...DEFAULT_INCIDENT_PARAMS, project: demoId }, NOW)).total).toBe(1);
    expect((await fetchEventFilterOptions(u.db, demoId)).endpoints).toContain(DEMO.endpoint);

    // A real project's own deployments would still show for it; "all" never returns demo deployments.
    expect(await fetchDeployments(u.db, { project: null, from: new Date(NOW.getTime() - 86_400_000), to: NOW })).toEqual([]);
  });

  it("a user whose only project is the demo sees empty 'all projects' data, not demo numbers", async () => {
    const u = await newUser();
    await admin.query("delete from public.projects where id = $1", [u.projectId]);
    await demoOf(u);
    const all = await fetchDashboardOverview(u.db, { project: null, range: "7d" }, NOW);
    expect(all.kpis.map((k) => k.value)).toEqual([0, 0, 0, 0]);
    expect(all.series.every((p) => p.events === 0)).toBe(true);
  });
});

describe("dashboard metrics on the demo scenario (exact values)", () => {
  let u: Awaited<ReturnType<typeof newUser>>;
  let project: { id: string; name: string; workspace: string; environment: string; isDemo: boolean };
  beforeAll(async () => {
    u = await newUser();
    const { projectId } = await demoOf(u);
    project = { id: projectId, name: DEMO.projectName, workspace: "", environment: "development", isDemo: true };
  });

  it("24 hours: the spike is visible, with error rate = 84 errors / 228 events", async () => {
    const o = await fetchDashboardOverview(u.db, { project, range: "24h" }, NOW);
    expect(kpi(o, "events").value).toBe(228); // 144 requests + 84 errors
    expect(kpi(o, "errorRate")).toMatchObject({ value: 36.8, detail: "84 errors of 228 events" });
    expect(kpi(o, "unresolved").value).toBe(1);
    expect(kpi(o, "endpoints").value).toBe(1);
    expect(o.severityBreakdown).toEqual([{ severity: "critical", count: 1 }, { severity: "high", count: 0 }, { severity: "medium", count: 0 }, { severity: "low", count: 0 }]);
    expect(o.deployments.map((d) => d.version)).toEqual([DEMO.versions.bad, DEMO.versions.good]);

    // Chart: 24 buckets, none empty (steady traffic), errors concentrated in the burst, recovery at the end.
    expect(o.series).toHaveLength(24);
    expect(o.series.every((p) => p.rate !== null)).toBe(true);
    expect(o.series.reduce((s, p) => s + p.events, 0)).toBe(228);
    expect(o.series.reduce((s, p) => s + p.errors, 0)).toBe(84);
    const rates = o.series.map((p) => p.rate as number);
    expect(Math.max(...rates)).toBeGreaterThan(50);
    expect(o.series.filter((p) => p.errors > 0).length).toBeLessThanOrEqual(3);
    expect(rates.at(-1)).toBe(0); // recovered
    expect(rates[0]).toBe(0); // normal baseline before the burst
  });

  it("shows only trends that are real: events yes (+58.3% from the burst), error rate no (previous was 0%)", async () => {
    const o = await fetchDashboardOverview(u.db, { project, range: "24h" }, NOW);
    expect(kpi(o, "events")).toMatchObject({ changePercent: 58.3, trendNote: null }); // (228-144)/144
    expect(kpi(o, "errorRate").changePercent).toBeNull();
    expect(kpi(o, "errorRate").trendNote).toMatch(/previous period was zero/);
    expect(kpi(o, "endpoints").changePercent).toBeNull();
    expect(kpi(o, "unresolved")).toMatchObject({ changePercent: null, trendNote: expect.stringMatching(/isn't tracked over time/) });
  });

  it("1 hour: recovered, no errors and nothing unresolved in the window", async () => {
    const o = await fetchDashboardOverview(u.db, { project, range: "1h" }, NOW);
    expect(kpi(o, "events").value).toBe(6);
    expect(kpi(o, "errorRate")).toMatchObject({ value: 0, detail: "0 errors of 6 events" });
    expect(kpi(o, "unresolved").value).toBe(0);
    expect(kpi(o, "endpoints").value).toBe(0);
    expect(o.series).toHaveLength(12);
    expect(o.deployments).toEqual([]);
  });

  it("7 days: no comparison is invented because TracePilot has no data from before the previous period", async () => {
    const o = await fetchDashboardOverview(u.db, { project, range: "7d" }, NOW);
    expect(kpi(o, "events").value).toBe(DEMO_TOTAL_EVENTS);
    expect(o.series).toHaveLength(28);
    for (const id of ["events", "errorRate", "endpoints"]) {
      expect(kpi(o, id).changePercent, id).toBeNull();
      expect(kpi(o, id).trendNote, id).toMatch(/no data from before the previous period/);
    }
  });

  it("KPIs agree with the underlying lists and raw tables", async () => {
    const range = "24h" as const;
    const o = await fetchDashboardOverview(u.db, { project, range }, NOW);
    const events = await fetchEventPage(u.db, { ...DEFAULT_EVENT_PARAMS, project: project.id, since: range }, {}, NOW);
    expect(kpi(o, "events").value).toBe(events.total);

    const unresolved = await fetchIncidentList(u.db, { ...DEFAULT_INCIDENT_PARAMS, project: project.id, status: "unresolved", since: range }, NOW);
    expect(kpi(o, "unresolved").value).toBe(unresolved.total);
    for (const s of o.severityBreakdown) {
      const list = await fetchIncidentList(u.db, { ...DEFAULT_INCIDENT_PARAMS, project: project.id, status: "unresolved", severity: s.severity, since: range }, NOW);
      expect(s.count, s.severity).toBe(list.total);
    }

    const from = new Date(NOW.getTime() - 86_400_000);
    const raw = (await admin.query(
      "select count(*) filter (where level in ('error','fatal'))::int errors, count(distinct endpoint) filter (where level in ('error','fatal'))::int endpoints from public.events where project_id = $1 and occurred_at >= $2 and occurred_at < $3",
      [project.id, from, NOW],
    )).rows[0];
    expect(kpi(o, "endpoints").value).toBe(raw.endpoints);
    expect(o.series.reduce((s, p) => s + p.errors, 0)).toBe(raw.errors);
    expect(kpi(o, "errorRate").detail).toBe(`${raw.errors} errors of ${events.total} events`);
  });
});

describe("time-range boundaries are half-open, UTC, and consistent everywhere", () => {
  it("includes an event at exactly `from` and excludes one at exactly `to`, to the millisecond", async () => {
    const u = await newUser();
    const N = new Date("2026-03-10T08:00:00.000Z");
    const at = (ms: number) => new Date(N.getTime() + ms).toISOString();
    const H = 3_600_000;
    await ingestEvents(service, u.projectId, [
      buildEvent({ message: "before window", level: "error", occurred_at: at(-H - 1), endpoint: "/a" }), // 1 ms before `from`
      buildEvent({ message: "at from", level: "error", occurred_at: at(-H), endpoint: "/b" }), //         exactly `from`: included
      buildEvent({ message: "on bucket edge", level: "info", occurred_at: at(-H + 5 * MIN) }), //         start of bucket 1
      buildEvent({ message: "just before to", level: "info", occurred_at: at(-1) }), //                    last ms: included
      buildEvent({ message: "at to", level: "error", occurred_at: at(0), endpoint: "/c" }), //             exactly `to`: excluded
    ]);
    const o = await fetchDashboardOverview(u.db, { project: null, range: "1h" }, N);

    expect(kpi(o, "events").value).toBe(3); // at from, on edge, just before to
    expect(kpi(o, "errorRate")).toMatchObject({ value: 33.3, detail: "1 error of 3 events" });
    expect(kpi(o, "endpoints").value).toBe(1); // only /b; /a is before the window and /c is at `to`
    expect(o.series.map((p) => p.events)).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]); // first, edge->bucket 1, last->bucket 11
    expect(o.series.map((p) => p.rate)).toEqual([100, 0, null, null, null, null, null, null, null, null, null, 0]);
    expect(o.series[0].time).toBe(new Date(N.getTime() - H).toISOString());

    // The lists use the identical window, so counts agree at the boundary.
    const events = await fetchEventPage(u.db, { ...DEFAULT_EVENT_PARAMS, since: "1h" }, {}, N);
    expect(events.total).toBe(3);
    expect(events.items.map((e) => e.message).sort()).toEqual(["at from", "just before to", "on bucket edge"].sort());
  });

  it("applies the same half-open window to incidents (last seen) and to the previous-period comparison", async () => {
    const u = await newUser();
    const N = new Date("2026-03-10T08:00:00.000Z");
    const H = 3_600_000;
    const make = (message: string, ms: number) => buildEvent({ message, level: "error", severity: "high", occurred_at: new Date(N.getTime() + ms).toISOString() });
    await ingestEvents(service, u.projectId, [make("first", -H), make("second", -1), make("third", 0), make("old", -H - 1)]);

    const o = await fetchDashboardOverview(u.db, { project: null, range: "1h" }, N);
    expect(kpi(o, "unresolved").value).toBe(2); // last seen at -1h (in) and -1ms (in); 0 (at to) and -1h-1ms (before) are out
    const list = await fetchIncidentList(u.db, { ...DEFAULT_INCIDENT_PARAMS, status: "unresolved", since: "1h" }, N);
    expect(list.total).toBe(2);
    // Previous period = [N-2h, N-1h): holds only the event at -1h-1ms.
    expect(kpi(o, "events").value).toBe(2);
  });

  it("is independent of the database session time zone (all UTC)", async () => {
    const u = await newUser();
    const N = new Date("2026-03-10T08:00:00.000Z");
    await ingestEvents(service, u.projectId, [buildEvent({ message: "tz", level: "error", occurred_at: new Date(N.getTime() - 30 * MIN).toISOString() })]);
    const client = await admin.connect();
    try {
      await client.query("set time zone 'Pacific/Kiritimati'"); // UTC+14
      await client.query("begin");
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claim.sub', $1, true)", [u.userId]);
      const { rows } = await client.query("select public.dashboard_overview(null, $1, $2, 12) as r", [new Date(N.getTime() - 3_600_000), N]);
      await client.query("rollback");
      expect(rows[0].r.events).toBe(1);
      expect(rows[0].r.series.filter((p: { events: number }) => p.events > 0)).toHaveLength(1);
    } finally {
      client.release();
    }
  });
});

describe("empty datasets never crash or invent numbers", () => {
  it("a user with no events gets zeros, empty-but-complete series, and explanations instead of trends", async () => {
    const u = await newUser();
    for (const range of ["1h", "24h", "7d"] as const) {
      const o = await fetchDashboardOverview(u.db, { project: null, range }, NOW);
      expect(o.kpis.map((k) => k.value), range).toEqual([0, 0, 0, 0]);
      expect(o.series.length).toBe({ "1h": 12, "24h": 24, "7d": 28 }[range]);
      expect(o.series.every((p) => p.events === 0 && p.errors === 0 && p.rate === null)).toBe(true); // gaps, not 0%
      expect(o.severityBreakdown.map((s) => s.count)).toEqual([0, 0, 0, 0]);
      expect(o.deployments).toEqual([]);
      expect(o.counts).toEqual({ unresolved: 0, critical: 0, recentlyResolved: 0, total: 0 });
      for (const k of o.kpis) {
        expect(k.changePercent, `${range}/${k.id}`).toBeNull();
        expect(k.trendNote, `${range}/${k.id}`).toBeTruthy();
      }
      expect(kpi(o, "errorRate").detail).toBe("No events in this window");
    }
  });

  it("a window with no events but older history reports 'no events to compare', not 0% or a trend", async () => {
    const u = await newUser();
    await ingestEvents(service, u.projectId, [buildEvent({ message: "ancient", level: "error", occurred_at: new Date(NOW.getTime() - 20 * 86_400_000).toISOString() })]);
    const o = await fetchDashboardOverview(u.db, { project: null, range: "24h" }, NOW);
    expect(kpi(o, "events").value).toBe(0);
    expect(kpi(o, "errorRate").changePercent).toBeNull();
    expect(o.series.every((p) => p.rate === null)).toBe(true);
  });

  it("only produces an error-rate trend when the previous period has enough events", async () => {
    const u = await newUser();
    // Previous 24h: 30 events with 3 errors (10%). Current 24h: 30 events with 6 errors (20%).
    const evs = [];
    for (let i = 0; i < 30; i++) evs.push(buildEvent({ message: `prev ${i}`, level: i < 3 ? "error" : "info", endpoint: "/x", occurred_at: new Date(NOW.getTime() - 25 * 3_600_000 - i * MIN).toISOString(), fingerprint: `a${i}`.padEnd(32, "0") }));
    for (let i = 0; i < 30; i++) evs.push(buildEvent({ message: `cur ${i}`, level: i < 6 ? "error" : "info", endpoint: "/x", occurred_at: new Date(NOW.getTime() - 2 * 3_600_000 - i * MIN).toISOString(), fingerprint: `b${i}`.padEnd(32, "0") }));
    for (let i = 0; i < evs.length; i += 50) await ingestEvents(service, u.projectId, evs.slice(i, i + 50));
    // Older history exists so the baseline is covered.
    await ingestEvents(service, u.projectId, [buildEvent({ message: "history", level: "info", occurred_at: new Date(NOW.getTime() - 5 * 86_400_000).toISOString() })]);

    const o = await fetchDashboardOverview(u.db, { project: null, range: "24h" }, NOW);
    expect(kpi(o, "errorRate")).toMatchObject({ value: 20, changePercent: 100, trendNote: null }); // 10% -> 20%
    expect(kpi(o, "events").changePercent).toBe(0); // 30 -> 30
  });
});

describe("indexes backing the aggregates", () => {
  it("exist", async () => {
    const { rows } = await admin.query("select indexname from pg_indexes where schemaname = 'public'");
    const names = rows.map((r) => r.indexname);
    for (const name of [
      "events_project_time_idx", "events_project_level_time_idx", "incidents_project_status_last_seen_idx",
      "deployments_project_time_idx", "projects_owner_demo_uniq", "incident_events_incident_idx",
    ]) expect(names, name).toContain(name);
  });
});

describe("the demo walkthrough, end to end", () => {
  it("dashboard spike -> incident -> events and stack traces -> investigation -> evidence -> resolve", async () => {
    const u = await newUser();
    const { projectId } = await demoOf(u);
    const project = { id: projectId, name: DEMO.projectName, workspace: "", environment: "development", isDemo: true };

    // 1-2. Open the dashboard and see the spike and the deployment markers.
    const overview = await fetchDashboardOverview(u.db, { project, range: "24h" }, NOW);
    expect(Math.max(...overview.series.map((p) => p.rate ?? 0))).toBeGreaterThan(50);
    expect(overview.deployments.map((d) => d.version)).toEqual([DEMO.versions.bad, DEMO.versions.good]);
    expect(overview.counts).toMatchObject({ unresolved: 1, critical: 1, recentlyResolved: 0 });

    // 3. Open the checkout incident from the recent-incidents list.
    const list = await fetchIncidentList(u.db, { ...DEFAULT_INCIDENT_PARAMS, project: projectId }, NOW);
    expect(list.items).toHaveLength(1);
    const incident = (await fetchIncident(u.db, list.items[0].id))!;
    expect(incident).toMatchObject({ severity: "critical", status: "open", occurrenceCount: 84, endpoint: DEMO.endpoint });

    // 4. Inspect events (paginated) and stack traces.
    const page1 = await fetchEventPage(u.db, { ...DEFAULT_EVENT_PARAMS, project: projectId }, { incidentId: incident.id, pageSize: 25 }, NOW);
    expect(page1).toMatchObject({ total: 84, pageCount: 4, pageSize: 25 });
    expect(page1.items).toHaveLength(25);
    const page4 = await fetchEventPage(u.db, { ...DEFAULT_EVENT_PARAMS, project: projectId, page: 4 }, { incidentId: incident.id, pageSize: 25 }, NOW);
    expect(page4.items).toHaveLength(9);
    expect(new Set([...page1.items, ...page4.items].map((e) => e.id)).size).toBe(34);
    const detail = (await u.db.rpc("get_event", { p_id: page1.items[0].id })).data as { stack_trace: string }[];
    expect(detail[0].stack_trace).toContain("reserveInventory");

    // 5. View the pre-written, clearly simulated investigation (no AI key needed).
    const saved = (await fetchLatestAnalysis(u.db, incident.id))!;
    expect(saved).toMatchObject({ status: "complete", simulated: true, model: DEMO.analysisModel });
    expect(saved.limitations.join(" ")).toMatch(/SIMULATED demo analysis/);
    expect(saved.hypotheses.length).toBeGreaterThanOrEqual(2);

    // 6. Review the supporting evidence: every citation is a real event in this incident.
    const incidentEventIds = new Set((await admin.query("select event_id from public.incident_events where incident_id = $1", [incident.id])).rows.map((r) => r.event_id));
    for (const h of saved.hypotheses) for (const e of h.evidence) expect(incidentEventIds.has(e.eventId), e.eventId).toBe(true);
    expect(await setAnalysisStep(u.db, { analysisId: saved.id, index: 0, done: true })).toEqual({ result: "ok", completedSteps: [0] });

    // 6b. Optionally run a live investigation: deployments appear as context in the prompt.
    const create = vi.fn<(p: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>>(async (params) => {
      const prompt = String((params.messages[0] as { content: string }).content);
      const ids = [...prompt.matchAll(/<event id="([0-9a-f-]{36})"/g)].map((m) => m[1]);
      return {
        stop_reason: "end_turn", model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 10 },
        content: [{ type: "text", text: JSON.stringify({ summary: "Live run.", hypotheses: [{ title: "Pool exhaustion", explanation: "e", confidence: "medium", evidence: [{ event_id: ids[0], why: "w" }] }], recommended_steps: [{ step: "Check pool" }], missing_information: [], limitations: ["live"] }) }],
      } as unknown as Anthropic.Message;
    });
    const live = await investigateIncident(u.db, incident.id, { config: { apiKey: "k", model: "claude-sonnet-5-5", timeoutMs: 5_000 }, client: { messages: { create } } as unknown as AiClient });
    expect(live.status).toBe("complete");
    const prompt = String((create.mock.calls[0][0].messages[0] as { content: string }).content);
    expect(prompt).toContain(`v${DEMO.versions.bad}`);
    expect(prompt).toContain(`v${DEMO.versions.good}`);
    expect(prompt).toContain("context only, not events");
    expect((await fetchLatestAnalysis(u.db, incident.id))?.simulated).toBe(false); // the new run is a real one

    // 7. Resolve the incident; every count updates consistently.
    expect(await changeIncidentStatus(u.db, { incidentId: incident.id, to: "resolved", expected: "open" })).toMatchObject({ result: "ok", status: "resolved" });
    expect((await fetchActivity(u.db, incident.id)).map((a) => `${a.fromStatus}->${a.toStatus}:${a.actor}`)).toEqual(["open->resolved:you"]);
    const after = await fetchDashboardOverview(u.db, { project, range: "24h" }, NOW);
    expect(kpi(after, "unresolved").value).toBe(0);
    expect(after.severityBreakdown.every((s) => s.count === 0)).toBe(true);
    expect(after.counts).toMatchObject({ unresolved: 0, critical: 0, recentlyResolved: 1 });
    // The error events are still in the data: resolving an incident does not rewrite history.
    expect(kpi(after, "errorRate").detail).toBe("84 errors of 228 events");
  });
});

describe("deployments", () => {
  it("are readable only by the project's owner and cannot be written by clients", async () => {
    const owner = await newUser();
    const { projectId } = await demoOf(owner);
    const other = await newUser();
    expect((await asUser(admin, owner.userId, (c) => c.query("select 1 from public.deployments"))).rowCount).toBe(2);
    expect((await asUser(admin, other.userId, (c) => c.query("select 1 from public.deployments"))).rowCount).toBe(0);
    await expect(asUser(admin, owner.userId, (c) => c.query("insert into public.deployments (project_id, version, deployed_at) values ($1, 'x', now())", [projectId]))).rejects.toThrow(/permission denied/);
    await expect(asAnon(admin, (c) => c.query("select 1 from public.deployments"))).rejects.toThrow(/permission denied/);
  });
});
