/**
 * Security review: privileges, RLS and function exposure, checked against the real schema (all migrations
 * applied to a real Postgres) as real roles. Nothing here is mocked.
 */
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemo } from "../../src/lib/demo/service";
import { adminPool, asAnon, asUser, buildEvent, createUserAndProject, ingestEvents, servicePool } from "./pg-harness";
import { createPgRpc } from "./pg-rpc";

const isEmpty = (d: unknown) => d === null || (Array.isArray(d) && d.length === 0);
const port = Number(process.env.TP_TEST_PG_PORT);
let admin: pg.Pool;
let service: pg.Pool;

beforeAll(() => {
  admin = adminPool(port);
  service = servicePool(port, 4);
});
afterAll(async () => {
  await admin.end();
  await service.end();
});

async function userWithIncident(name: string) {
  const u = await createUserAndProject(admin, name);
  await ingestEvents(service, u.projectId, [buildEvent({ message: `${name} failure`, level: "error" })]);
  const incidentId = (await admin.query("select id from public.incidents where project_id = $1", [u.projectId])).rows[0].id as string;
  return { ...u, incidentId, db: createPgRpc(admin, u.userId) };
}

describe("schema-wide privilege sweep", () => {
  it("every public table has row level security enabled", async () => {
    const { rows } = await admin.query("select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity");
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("anon has no privilege on any public table or on any function except none", async () => {
    const tables = await admin.query("select table_name, privilege_type from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon'");
    expect(tables.rows).toEqual([]);
    const fns = await admin.query(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prokind = 'f' and has_function_privilege('anon', p.oid, 'execute')
          and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`,
    );
    expect(fns.rows.map((r) => r.proname)).toEqual([]);
  });

  it("every SECURITY DEFINER function pins its search_path and is not executable by signed-in users unless it checks ownership", async () => {
    const { rows } = await admin.query(
      `select p.proname, p.proconfig, has_function_privilege('authenticated', p.oid, 'execute') as authed
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef order by p.proname`,
    );
    for (const r of rows) expect((r.proconfig ?? []).some((c: string) => c.startsWith("search_path=")), `${r.proname} pins search_path`).toBe(true);
    // Functions that bypass RLS for the ingestion service must never be callable by users.
    const serviceOnly = new Set(["authenticate_ingest_key", "consume_rate_limit", "ingest_events"]);
    for (const r of rows.filter((x) => serviceOnly.has(x.proname))) expect(r.authed, `${r.proname} is service-only`).toBe(false);
    // Everything else that signed-in users can run as definer must be an explicitly reviewed one.
    const reviewed = new Set(["seed_demo_project", "remove_demo_project", "start_analysis", "finish_analysis", "set_analysis_step", "incidents_status_guard", "touch_updated_at"]);
    const unexpected = rows.filter((r) => r.authed && !reviewed.has(r.proname)).map((r) => r.proname);
    expect(unexpected).toEqual([]);
  });

  it("users cannot write events, incidents (other than status), incident_events, rate_limits or deployments", async () => {
    const u = await userWithIncident("writes");
    const attempts = [
      "insert into public.events (project_id, external_event_id, event_type, level, message, fingerprint, occurred_at) values ('{p}', 'x', 't', 'error', 'm', 'f', now())",
      "delete from public.events",
      "update public.events set message = 'tampered'",
      "update public.incidents set title = 'tampered', severity = 'low'",
      "delete from public.incidents",
      "delete from public.incident_events",
      "insert into public.rate_limits (bucket, window_start, count) values ('x', now(), 0)",
      "select * from public.rate_limits",
      "insert into public.deployments (project_id, version, deployed_at) values ('{p}', 'x', now())",
    ];
    for (const sql of attempts) {
      await expect(asUser(admin, u.userId, (c) => c.query(sql.replaceAll("{p}", u.projectId))), sql).rejects.toThrow(/permission denied/);
    }
  });
});

describe("analyses are read-only for users (cost guard and integrity)", () => {
  it("cannot be inserted, updated or deleted directly", async () => {
    const u = await userWithIncident("direct");
    const started = (await u.db.rpc("start_analysis", { p_incident: u.incidentId, p_model: "m" })).data as { id: string };
    for (const sql of [
      `insert into public.analyses (incident_id, status, model) values ('${u.incidentId}', 'complete', 'forged')`,
      `update public.analyses set status = 'complete', summary = 'forged' where id = '${started.id}'`,
      `update public.analyses set created_at = now() - interval '2 days' where id = '${started.id}'`,
      "delete from public.analyses",
    ]) {
      await expect(asUser(admin, u.userId, (c) => c.query(sql)), sql).rejects.toThrow(/permission denied/);
    }
    // Reading their own is fine.
    expect((await asUser(admin, u.userId, (c) => c.query("select id from public.analyses"))).rowCount).toBe(1);
  });

  it("the 20-per-hour cost guard cannot be bypassed by deleting rows", async () => {
    const u = await userWithIncident("guard");
    // Complete each analysis so the next can start (one pending per incident).
    for (let i = 0; i < 20; i++) {
      const s = (await u.db.rpc("start_analysis", { p_incident: u.incidentId, p_model: "m" })).data as { result: string; id: string };
      expect(s.result).toBe("started");
      await u.db.rpc("finish_analysis", { p_id: s.id, p_status: "failed", p_summary: null, p_hypotheses: [], p_evidence: [], p_steps: [], p_missing: [], p_limitations: [], p_input_events: 0, p_usage: null, p_model: null, p_error: "x", p_error_code: "timeout", p_retryable: true });
    }
    // Attempt the bypass: delete and back-date.
    await expect(asUser(admin, u.userId, (c) => c.query("delete from public.analyses"))).rejects.toThrow(/permission denied/);
    await expect(asUser(admin, u.userId, (c) => c.query("update public.analyses set created_at = now() - interval '3 hours'"))).rejects.toThrow(/permission denied/);
    expect(((await u.db.rpc("start_analysis", { p_incident: u.incidentId, p_model: "m" })).data as { result: string }).result).toBe("rate_limited");
  });

  it("the cost guard is per user: one user's usage does not block another", async () => {
    const a = await userWithIncident("guard-a");
    const b = await userWithIncident("guard-b");
    expect(((await a.db.rpc("start_analysis", { p_incident: a.incidentId, p_model: "m" })).data as { result: string }).result).toBe("started");
    expect(((await b.db.rpc("start_analysis", { p_incident: b.incidentId, p_model: "m" })).data as { result: string }).result).toBe("started");
  });

  it("lifecycle functions enforce ownership even though they bypass RLS", async () => {
    const a = await userWithIncident("owner");
    const b = await userWithIncident("intruder");
    // B cannot start an analysis on A's incident.
    expect((await b.db.rpc("start_analysis", { p_incident: a.incidentId, p_model: "m" })).data).toEqual({ result: "not_found" });
    expect(Number((await admin.query("select count(*) n from public.analyses where incident_id = $1", [a.incidentId])).rows[0].n)).toBe(0);

    // A starts one; B cannot finish it or tick its steps.
    const started = (await a.db.rpc("start_analysis", { p_incident: a.incidentId, p_model: "m" })).data as { id: string };
    const finishArgs = (id: string) => ({ p_id: id, p_status: "complete", p_summary: "pwned", p_hypotheses: [], p_evidence: [], p_steps: [{ step: "s" }], p_missing: [], p_limitations: [], p_input_events: 1, p_usage: null, p_model: null, p_error: null, p_error_code: null, p_retryable: false });
    expect((await b.db.rpc("finish_analysis", finishArgs(started.id))).data).toBe(false);
    expect((await admin.query("select status from public.analyses where id = $1", [started.id])).rows[0].status).toBe("pending");

    expect((await a.db.rpc("finish_analysis", finishArgs(started.id))).data).toBe(true);
    expect((await b.db.rpc("set_analysis_step", { p_analysis: started.id, p_index: 0, p_done: true })).data).toEqual({ result: "not_found" });
    expect((await a.db.rpc("set_analysis_step", { p_analysis: started.id, p_index: 0, p_done: true })).data).toMatchObject({ result: "ok" });

    // Finishing twice is a no-op.
    expect((await a.db.rpc("finish_analysis", finishArgs(started.id))).data).toBe(false);
  });

  it("anonymous callers cannot call the lifecycle functions", async () => {
    const u = await userWithIncident("anon");
    const anon = createPgRpc(admin, null);
    expect((await anon.rpc("start_analysis", { p_incident: u.incidentId, p_model: "m" })).error?.message).toMatch(/permission denied/);
  });
});

describe("cross-user and cross-project reads", () => {
  it("another user sees nothing of a user's data through any table or read function", async () => {
    const a = await userWithIncident("victim");
    await a.db.rpc("start_analysis", { p_incident: a.incidentId, p_model: "m" });
    const demo = await seedDemo(a.db, { now: new Date("2026-06-01T12:00:00Z") });
    expect(demo.ok).toBe(true);
    const b = await userWithIncident("snoop");

    // Nothing of A's (user id, project id, incident id, analysis, demo project) may appear in anything B can read.
    const mine = [a.userId, a.projectId, a.incidentId];
    for (const table of ["projects", "incidents", "events", "incident_events", "analyses", "incident_activity", "deployments", "api_keys"]) {
      const cols = table === "api_keys" ? "id, project_id, name, key_prefix" : "*";
      const { rows } = await asUser(admin, b.userId, (c) => c.query(`select ${cols} from public.${table}`));
      const dump = JSON.stringify(rows);
      for (const id of mine) expect(dump.includes(id), `${table} leaks ${id}`).toBe(false);
    }
    const demoId = demo.ok ? demo.projectId : "";
    expect(JSON.stringify((await asUser(admin, b.userId, (c) => c.query("select id from public.projects"))).rows).includes(demoId)).toBe(false);

    const rpc = b.db.rpc.bind(b.db);
    expect([null, []]).toContainEqual((await rpc("get_incident", { p_id: a.incidentId })).data);
    expect(isEmpty((await rpc("select_evidence_events", { p_incident: a.incidentId, p_recent: 6, p_representative: 4 })).data)).toBe(true);
    expect(isEmpty((await rpc("get_latest_analysis", { p_incident: a.incidentId })).data)).toBe(true);
    const events = (await rpc("list_events", { p_project: a.projectId, p_search: null, p_type: null, p_level: null, p_endpoint: null, p_incident: null, p_from: null, p_to: null, p_limit: 50, p_offset: 0 })).data as unknown[];
    expect(isEmpty(events)).toBe(true);
  });

  it("a user cannot move their data into someone else's project", async () => {
    const a = await createUserAndProject(admin, "mine");
    const b = await createUserAndProject(admin, "theirs");
    await expect(
      asUser(admin, a.userId, (c) => c.query("insert into public.api_keys (project_id, name, key_prefix, key_hash) values ($1, 'x', 'tp_live_abcd', repeat('a', 64))", [b.projectId])),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asUser(admin, a.userId, (c) => c.query("insert into public.projects (owner_id, name) values ($1, 'forged owner')", [b.userId])),
    ).rejects.toThrow(/row-level security/);
  });

  it("anonymous callers read nothing", async () => {
    await expect(asAnon(admin, (c) => c.query("select * from public.projects"))).rejects.toThrow(/permission denied/);
    await expect(asAnon(admin, (c) => c.query("select * from public.events"))).rejects.toThrow(/permission denied/);
  });
});

describe("API key storage", () => {
  it("the key hash is never selectable by users and revoked keys cannot authenticate", async () => {
    const u = await createUserAndProject(admin, "keys");
    const hash = "b".repeat(64);
    const { rows } = await admin.query("insert into public.api_keys (project_id, name, key_prefix, key_hash) values ($1, 'k', 'tp_live_abcd', $2) returning id", [u.projectId, hash]);
    await expect(asUser(admin, u.userId, (c) => c.query("select key_hash from public.api_keys"))).rejects.toThrow(/permission denied/);
    await expect(asUser(admin, u.userId, (c) => c.query("select * from public.api_keys"))).rejects.toThrow(/permission denied/);
    expect((await service.query("select public.authenticate_ingest_key($1) r", [hash])).rows[0].r).not.toBeNull();
    await asUser(admin, u.userId, (c) => c.query("update public.api_keys set revoked_at = now() where id = $1", [rows[0].id])).catch(() => undefined);
    await admin.query("update public.api_keys set revoked_at = now() where id = $1", [rows[0].id]);
    expect((await service.query("select public.authenticate_ingest_key($1) r", [hash])).rows[0].r).toBeNull();
  });
});

describe("supabase/verify.sql (the post-migration checklist users run)", () => {
  it("reports every check as ok on a freshly migrated database", async () => {
    const sql = (await import("node:fs")).readFileSync(new URL("../../supabase/verify.sql", import.meta.url), "utf8");
    const { rows } = await admin.query(sql);
    expect(rows.length).toBeGreaterThan(25);
    expect(rows.filter((r) => !r.ok).map((r) => r.check)).toEqual([]);
  });
});
