import EmbeddedPostgres from "embedded-postgres";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import pg from "pg";

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../supabase/migrations");

export type TestDatabase = { port: number; stop: () => Promise<void> };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Stand-ins for the parts of Supabase that migrations depend on (roles, auth schema, default grants). */
const SUPABASE_BOOTSTRAP = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;

  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

  grant usage on schema public, auth to anon, authenticated, service_role;
  -- Supabase grants everything on new public objects to these roles; migrations then narrow it.
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  grant select on auth.users to service_role;
`;

export async function startDatabase(): Promise<TestDatabase> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracepilot-pg-"));
  const port = await freePort();
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await server.initialise();
  await server.start();

  const admin = new pg.Client(adminConfig(port));
  await admin.connect();
  try {
    await admin.query(SUPABASE_BOOTSTRAP);
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      await admin.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
    }
  } finally {
    await admin.end();
  }

  return {
    port,
    stop: async () => {
      await server.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function adminConfig(port: number): pg.ClientConfig {
  return { host: "127.0.0.1", port, user: "postgres", password: "postgres", database: "postgres" };
}

/** Superuser pool: for arranging test data (users, projects, keys) and asserting on raw tables. */
export function adminPool(port: number): pg.Pool {
  return new pg.Pool({ ...adminConfig(port), max: 4 });
}

/** Pool whose connections run as the `service_role` role, exactly like the server's admin client. */
export function servicePool(port: number, max = 10): pg.Pool {
  const pool = new pg.Pool({ ...adminConfig(port), max });
  pool.on("connect", (client) => {
    void client.query("set role service_role");
  });
  return pool;
}

/** Runs `fn` inside a transaction as a signed-in Supabase user (role authenticated + JWT sub claim). */
export async function asUser<T>(pool: pg.Pool, userId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    const result = await fn(client);
    await client.query("rollback");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Runs `fn` as the anon role (no session). */
export async function asAnon<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role anon");
    const result = await fn(client);
    await client.query("rollback");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function createUserAndProject(pool: pg.Pool, name = "test-project") {
  const user = await pool.query<{ id: string }>("insert into auth.users (email) values ($1) returning id", [
    `u-${crypto.randomUUID()}@example.com`,
  ]);
  const userId = user.rows[0].id;
  const project = await pool.query<{ id: string }>(
    "insert into public.projects (owner_id, name) values ($1, $2) returning id",
    [userId, `${name}-${crypto.randomUUID().slice(0, 8)}`],
  );
  return { userId, projectId: project.rows[0].id };
}

export type TestEvent = {
  external_event_id?: string;
  event_type?: string;
  level?: string;
  message?: string;
  stack_trace?: string | null;
  fingerprint?: string;
  title?: string;
  severity?: string;
  endpoint?: string | null;
  occurred_at?: string;
  attributes?: unknown;
};

let seq = 0;
/** A complete, valid ingest_events payload entry; override anything. Fingerprint defaults to a hash of the message. */
export function buildEvent(over: TestEvent = {}) {
  const message = over.message ?? "Something failed";
  return {
    external_event_id: over.external_event_id ?? `ev-${Date.now()}-${seq++}-${Math.random().toString(36).slice(2, 8)}`,
    event_type: over.event_type ?? "Error",
    level: over.level ?? "error",
    message,
    stack_trace: over.stack_trace ?? null,
    fingerprint: over.fingerprint ?? createHash("sha256").update(message).digest("hex").slice(0, 32),
    title: over.title ?? message,
    severity: over.severity ?? "high",
    endpoint: over.endpoint === undefined ? "/api/x" : over.endpoint,
    occurred_at: over.occurred_at ?? new Date().toISOString(),
    attributes: over.attributes ?? {},
  };
}

/** Ingests through the real service-role function and returns its per-event results. */
export async function ingestEvents(service: pg.Pool, projectId: string, events: ReturnType<typeof buildEvent>[]) {
  const { rows } = await service.query("select public.ingest_events($1, $2::jsonb) as r", [projectId, JSON.stringify(events)]);
  return rows[0].r.results as { external_event_id: string; status: string; incident_id: string; occurrence_count: number }[];
}
