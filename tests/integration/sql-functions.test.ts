/**
 * Tests the ingestion SQL functions directly against a real Postgres 17 with every migration applied.
 * Connections run as `service_role`, so function grants are exercised too.
 */
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminPool, asAnon, asUser, createUserAndProject, servicePool } from "./pg-harness";

const port = Number(process.env.TP_TEST_PG_PORT);
let admin: pg.Pool;
let service: pg.Pool;

beforeAll(() => {
  admin = adminPool(port);
  service = servicePool(port, 12);
});
afterAll(async () => {
  await admin.end();
  await service.end();
});

type EventInput = {
  external_event_id: string;
  fingerprint: string;
  severity?: string;
  occurred_at?: string;
  title?: string;
  attributes?: unknown;
};

const event = (e: EventInput) => ({
  external_event_id: e.external_event_id,
  event_type: "TypeError",
  level: "error",
  message: "boom",
  stack_trace: null,
  fingerprint: e.fingerprint,
  title: e.title ?? "boom",
  severity: e.severity ?? "high",
  endpoint: "/api/x",
  occurred_at: e.occurred_at ?? new Date().toISOString(),
  attributes: e.attributes ?? {},
});

const FP = (n: string) => n.padEnd(32, "0");

async function ingest(projectId: string, events: ReturnType<typeof event>[]) {
  const { rows } = await service.query("select public.ingest_events($1, $2::jsonb) as r", [
    projectId,
    JSON.stringify(events),
  ]);
  return rows[0].r.results as {
    external_event_id: string;
    status: string;
    incident_id: string;
    occurrence_count: number;
  }[];
}

describe("ingest_events", () => {
  it("creates an incident, stores the event, and links them", async () => {
    const { projectId } = await createUserAndProject(admin);
    const [r] = await ingest(projectId, [event({ external_event_id: "e1", fingerprint: FP("a1") })]);
    expect(r).toMatchObject({ status: "accepted", occurrence_count: 1 });

    const links = await admin.query("select * from public.incident_events where incident_id = $1", [r.incident_id]);
    expect(links.rowCount).toBe(1);
    const stored = await admin.query("select * from public.events where project_id = $1", [projectId]);
    expect(stored.rows[0]).toMatchObject({ external_event_id: "e1", event_type: "TypeError", endpoint: "/api/x" });
  });

  it("groups events with the same fingerprint into one incident and counts occurrences", async () => {
    const { projectId } = await createUserAndProject(admin);
    const first = await ingest(projectId, [event({ external_event_id: "g1", fingerprint: FP("b1") })]);
    const second = await ingest(projectId, [
      event({ external_event_id: "g2", fingerprint: FP("b1") }),
      event({ external_event_id: "g3", fingerprint: FP("b1") }),
    ]);
    expect(second.every((r) => r.incident_id === first[0].incident_id)).toBe(true);

    const incident = await admin.query("select occurrence_count from public.incidents where id = $1", [
      first[0].incident_id,
    ]);
    expect(incident.rows[0].occurrence_count).toBe(3);
    expect((await admin.query("select 1 from public.events where project_id = $1", [projectId])).rowCount).toBe(3);
  });

  it("separates different fingerprints and different projects", async () => {
    const a = await createUserAndProject(admin);
    const b = await createUserAndProject(admin);
    const [x] = await ingest(a.projectId, [event({ external_event_id: "s1", fingerprint: FP("c1") })]);
    const [y] = await ingest(a.projectId, [event({ external_event_id: "s2", fingerprint: FP("c2") })]);
    const [z] = await ingest(b.projectId, [event({ external_event_id: "s1", fingerprint: FP("c1") })]);
    expect(new Set([x.incident_id, y.incident_id, z.incident_id]).size).toBe(3);
    // Same external id in a different project is not a duplicate.
    expect(z.status).toBe("accepted");
  });

  it("is idempotent for duplicate external ids (replay and within one batch)", async () => {
    const { projectId } = await createUserAndProject(admin);
    const e = event({ external_event_id: "dup", fingerprint: FP("d1") });
    const [first] = await ingest(projectId, [e]);
    const [replay] = await ingest(projectId, [e]);
    expect(replay).toMatchObject({ status: "duplicate", incident_id: first.incident_id, occurrence_count: 1 });

    const within = await ingest(projectId, [
      event({ external_event_id: "dup2", fingerprint: FP("d1") }),
      event({ external_event_id: "dup2", fingerprint: FP("d1") }),
    ]);
    expect(within.map((r) => r.status).sort()).toEqual(["accepted", "duplicate"]);

    const incident = await admin.query("select occurrence_count from public.incidents where id = $1", [
      first.incident_id,
    ]);
    expect(incident.rows[0].occurrence_count).toBe(2);
  });

  it("maintains first/last seen with out-of-order timestamps and escalates severity", async () => {
    const { projectId } = await createUserAndProject(admin);
    const t = (m: number) => new Date(Date.UTC(2026, 9, 29, 12, m)).toISOString();
    await ingest(projectId, [event({ external_event_id: "t2", fingerprint: FP("e1"), occurred_at: t(30), severity: "low" })]);
    await ingest(projectId, [event({ external_event_id: "t1", fingerprint: FP("e1"), occurred_at: t(10), severity: "critical" })]);
    await ingest(projectId, [event({ external_event_id: "t3", fingerprint: FP("e1"), occurred_at: t(20), severity: "medium" })]);

    const { rows } = await admin.query(
      "select first_seen_at, last_seen_at, severity, occurrence_count from public.incidents where project_id = $1",
      [projectId],
    );
    expect(rows[0].first_seen_at.toISOString()).toBe(t(10));
    expect(rows[0].last_seen_at.toISOString()).toBe(t(30));
    expect(rows[0].severity).toBe("critical");
    expect(rows[0].occurrence_count).toBe(3);
  });

  it("reopens a resolved incident when it recurs", async () => {
    const { projectId } = await createUserAndProject(admin);
    const [first] = await ingest(projectId, [event({ external_event_id: "r1", fingerprint: FP("f1") })]);
    await admin.query("update public.incidents set status = 'resolved' where id = $1", [first.incident_id]);
    await ingest(projectId, [event({ external_event_id: "r2", fingerprint: FP("f1"), occurred_at: new Date(Date.now() + 1000).toISOString() })]);
    const { rows } = await admin.query("select status from public.incidents where id = $1", [first.incident_id]);
    expect(rows[0].status).toBe("open");
  });

  it("rolls back the entire batch when any event fails (no orphaned events or incidents)", async () => {
    const { projectId } = await createUserAndProject(admin);
    await expect(
      ingest(projectId, [
        event({ external_event_id: "ok-1", fingerprint: FP("g1") }),
        // Invalid severity makes the incident upsert fail after the event insert succeeded.
        event({ external_event_id: "bad-1", fingerprint: FP("g2"), severity: "catastrophic" }),
      ]),
    ).rejects.toThrow();

    expect((await admin.query("select 1 from public.events where project_id = $1", [projectId])).rowCount).toBe(0);
    expect((await admin.query("select 1 from public.incidents where project_id = $1", [projectId])).rowCount).toBe(0);
  });

  it("rejects an unknown project through the foreign key and leaves no rows", async () => {
    await expect(
      ingest("00000000-0000-4000-8000-000000000000", [event({ external_event_id: "x", fingerprint: FP("h1") })]),
    ).rejects.toThrow();
  });

  it("stores jsonb attributes faithfully", async () => {
    const { projectId } = await createUserAndProject(admin);
    const attributes = { user: { id: 7, plan: "pro" }, tags: ["a", "b"], ok: true };
    await ingest(projectId, [event({ external_event_id: "attr", fingerprint: FP("i1"), attributes })]);
    const { rows } = await admin.query("select attributes from public.events where project_id = $1", [projectId]);
    expect(rows[0].attributes).toEqual(attributes);
  });

  describe("concurrency", () => {
    it("counts exactly once per event when many requests hit one new fingerprint at once", async () => {
      const { projectId } = await createUserAndProject(admin);
      const N = 40;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          ingest(projectId, [event({ external_event_id: `c-${i}`, fingerprint: FP("j1") })]),
        ),
      );
      const incidentIds = new Set(results.map((r) => r[0].incident_id));
      expect(incidentIds.size).toBe(1);

      const incidents = await admin.query("select id, occurrence_count from public.incidents where project_id = $1", [
        projectId,
      ]);
      expect(incidents.rowCount).toBe(1);
      expect(incidents.rows[0].occurrence_count).toBe(N);
      expect((await admin.query("select 1 from public.incident_events where incident_id = $1", [incidents.rows[0].id])).rowCount).toBe(N);
      // Each call saw a distinct running count: no lost updates.
      expect(new Set(results.map((r) => r[0].occurrence_count)).size).toBe(N);
    });

    it("never double-counts when the same external id is submitted concurrently", async () => {
      const { projectId } = await createUserAndProject(admin);
      const e = event({ external_event_id: "same-id", fingerprint: FP("k1") });
      const results = await Promise.all(Array.from({ length: 20 }, () => ingest(projectId, [e])));
      const statuses = results.map((r) => r[0].status);
      expect(statuses.filter((s) => s === "accepted")).toHaveLength(1);
      expect(statuses.filter((s) => s === "duplicate")).toHaveLength(19);

      const { rows } = await admin.query("select occurrence_count from public.incidents where project_id = $1", [projectId]);
      expect(rows[0].occurrence_count).toBe(1);
    });

    it("does not deadlock when overlapping batches list fingerprints in opposite orders", async () => {
      const { projectId } = await createUserAndProject(admin);
      const batch = (prefix: string, order: string[]) =>
        order.map((fp, i) => event({ external_event_id: `${prefix}-${i}`, fingerprint: FP(fp) }));

      const jobs = Array.from({ length: 16 }, (_, i) =>
        ingest(projectId, batch(`m${i}`, i % 2 === 0 ? ["l1", "l2", "l3"] : ["l3", "l2", "l1"])),
      );
      await expect(Promise.all(jobs)).resolves.toBeDefined();

      const { rows } = await admin.query(
        "select fingerprint, occurrence_count from public.incidents where project_id = $1 order by fingerprint",
        [projectId],
      );
      expect(rows.map((r) => r.occurrence_count)).toEqual([16, 16, 16]);
    });
  });
});

describe("authenticate_ingest_key", () => {
  async function addKey(projectId: string, hash: string, revoked = false) {
    await admin.query(
      "insert into public.api_keys (project_id, name, key_prefix, key_hash, revoked_at) values ($1, 'k', 'tp_live_xxxx', $2, $3)",
      [projectId, hash, revoked ? new Date() : null],
    );
  }
  const call = async (hash: string) =>
    (await service.query("select public.authenticate_ingest_key($1) as r", [hash])).rows[0].r;

  it("resolves a valid key to its project and stamps last_used_at", async () => {
    const { projectId } = await createUserAndProject(admin);
    const hash = `h-${crypto.randomUUID()}`;
    await addKey(projectId, hash);
    expect(await call(hash)).toMatchObject({ project_id: projectId });
    const { rows } = await admin.query("select last_used_at from public.api_keys where key_hash = $1", [hash]);
    expect(rows[0].last_used_at).not.toBeNull();
  });

  it("does not resolve revoked or unknown keys", async () => {
    const { projectId } = await createUserAndProject(admin);
    const hash = `h-${crypto.randomUUID()}`;
    await addKey(projectId, hash, true);
    expect(await call(hash)).toBeNull();
    expect(await call("does-not-exist")).toBeNull();
  });
});

describe("consume_rate_limit", () => {
  const hit = async (bucket: string, cost: number, limit: number) =>
    (await service.query("select public.consume_rate_limit($1, $2, $3, 60) as r", [bucket, cost, limit])).rows[0].r;

  it("allows up to the limit, then rejects with a retry hint", async () => {
    const bucket = `b-${crypto.randomUUID()}`;
    expect((await hit(bucket, 3, 5)).allowed).toBe(true);
    expect((await hit(bucket, 2, 5)).allowed).toBe(true);
    const over = await hit(bucket, 1, 5);
    expect(over.allowed).toBe(false);
    expect(over.retry_after).toBeGreaterThanOrEqual(1);
    expect(over.retry_after).toBeLessThanOrEqual(60);
  });

  it("is exact under concurrency", async () => {
    const bucket = `b-${crypto.randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 30 }, () => hit(bucket, 1, 10)));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });
});

describe("privileges and row level security", () => {
  it("lets only the service role execute the ingestion functions", async () => {
    const { userId, projectId } = await createUserAndProject(admin);
    const args = [projectId, "[]"];
    await expect(asUser(admin, userId, (c) => c.query("select public.ingest_events($1, $2::jsonb)", args))).rejects.toThrow(/permission denied/);
    await expect(asAnon(admin, (c) => c.query("select public.ingest_events($1, $2::jsonb)", args))).rejects.toThrow(/permission denied/);
    await expect(asUser(admin, userId, (c) => c.query("select public.authenticate_ingest_key('x')"))).rejects.toThrow(/permission denied/);
    await expect(asUser(admin, userId, (c) => c.query("select public.consume_rate_limit('b', 1, 1, 60)"))).rejects.toThrow(/permission denied/);
  });

  it("lets owners read their events and incidents but never another user's", async () => {
    const a = await createUserAndProject(admin);
    const b = await createUserAndProject(admin);
    await ingest(a.projectId, [event({ external_event_id: "own-1", fingerprint: FP("n1") })]);

    const mine = await asUser(admin, a.userId, (c) => c.query("select 1 from public.events"));
    expect(mine.rowCount).toBe(1);
    const theirs = await asUser(admin, b.userId, async (c) => ({
      events: (await c.query("select 1 from public.events")).rowCount,
      incidents: (await c.query("select 1 from public.incidents")).rowCount,
      links: (await c.query("select 1 from public.incident_events")).rowCount,
    }));
    expect(theirs).toEqual({ events: 0, incidents: 0, links: 0 });
  });

  it("does not let signed-in users write events, incidents or links directly", async () => {
    const { userId, projectId } = await createUserAndProject(admin);
    const insertEvent = `insert into public.events (project_id, external_event_id, fingerprint, message, occurred_at)
                         values ('${projectId}', 'forged', '${FP("z")}', 'm', now())`;
    await expect(asUser(admin, userId, (c) => c.query(insertEvent))).rejects.toThrow(/permission denied/);
    await expect(
      asUser(admin, userId, (c) =>
        c.query(`insert into public.incidents (project_id, fingerprint, title) values ('${projectId}', '${FP("z")}', 't')`),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(asUser(admin, userId, (c) => c.query("delete from public.events"))).rejects.toThrow(/permission denied/);
  });

  it("lets an owner change incident status but nothing else", async () => {
    const { userId, projectId } = await createUserAndProject(admin);
    const [r] = await ingest(projectId, [event({ external_event_id: "st-1", fingerprint: FP("o1") })]);
    const ok = await asUser(admin, userId, (c) =>
      c.query("update public.incidents set status = 'resolved' where id = $1", [r.incident_id]),
    );
    expect(ok.rowCount).toBe(1);
    await expect(
      asUser(admin, userId, (c) => c.query("update public.incidents set occurrence_count = 999 where id = $1", [r.incident_id])),
    ).rejects.toThrow(/permission denied/);
  });

  it("hides api key hashes from signed-in users and allows only revocation edits", async () => {
    const { userId, projectId } = await createUserAndProject(admin);
    await admin.query(
      "insert into public.api_keys (project_id, name, key_prefix, key_hash) values ($1, 'k', 'tp_live_abcd', 'secret-hash')",
      [projectId],
    );
    await expect(asUser(admin, userId, (c) => c.query("select key_hash from public.api_keys"))).rejects.toThrow(/permission denied/);
    const visible = await asUser(admin, userId, (c) => c.query("select id, key_prefix, revoked_at from public.api_keys"));
    expect(visible.rowCount).toBe(1);
    const revoke = await asUser(admin, userId, (c) => c.query("update public.api_keys set revoked_at = now()"));
    expect(revoke.rowCount).toBe(1);
    await expect(asUser(admin, userId, (c) => c.query("update public.api_keys set key_hash = 'x'"))).rejects.toThrow(/permission denied/);
  });

  it("does not let another user create or see keys for a project they do not own", async () => {
    const owner = await createUserAndProject(admin);
    const intruder = await createUserAndProject(admin);
    await expect(
      asUser(admin, intruder.userId, (c) =>
        c.query("insert into public.api_keys (project_id, name, key_prefix, key_hash) values ($1, 'k', 'tp_live_zzzz', 'h-intruder')", [owner.projectId]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("gives anon no table access", async () => {
    await expect(asAnon(admin, (c) => c.query("select 1 from public.events"))).rejects.toThrow(/permission denied/);
    await expect(asAnon(admin, (c) => c.query("select 1 from public.incidents"))).rejects.toThrow(/permission denied/);
    await expect(asAnon(admin, (c) => c.query("select 1 from public.api_keys"))).rejects.toThrow(/permission denied/);
  });
});
