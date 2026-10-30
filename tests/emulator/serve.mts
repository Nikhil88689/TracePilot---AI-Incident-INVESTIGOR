/**
 * LOCAL SUPABASE EMULATOR, for running the real app in a real browser without a Supabase account.
 *
 * It is NOT Supabase. It is a small HTTP server that speaks just enough of GoTrue (password sign-in, user,
 * refresh, sign-out) and PostgREST (rpc, plus select/insert/update with simple filters) for TracePilot, in
 * front of a REAL embedded Postgres 17 that has every migration applied. Each request runs in a transaction as
 * role anon / authenticated (JWT sub set) / service_role, so Row Level Security, column grants and function
 * privileges behave exactly as the migrations define them.
 *
 * What it does not cover: email delivery and confirmation, OAuth, PostgREST features TracePilot does not use,
 * Supabase's connection pooling, rate limits, and real network latency. Treat results as "the app against the
 * real schema", never as "tested on Supabase".
 *
 * Usage (see README "Local end-to-end run"):  npx tsx tests/emulator/serve.mts
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import pg from "pg";
import { adminConfig, startDatabase } from "../integration/pg-harness";

const PORT = Number(process.env.EMULATOR_PORT ?? 54321);
export const ANON_KEY = process.env.EMULATOR_ANON_KEY ?? "emulator-anon-key";
export const SERVICE_KEY = process.env.EMULATOR_SERVICE_KEY ?? "emulator-service-key";
const JWT_SECRET = randomBytes(32);

type User = { id: string; email: string; password: string };
const users = new Map<string, User>(); // by email
const refreshTokens = new Map<string, string>(); // token -> user id

const db = await startDatabase();
const pool = new pg.Pool({ ...adminConfig(db.port), max: 12 });

// ---- JWT (HS256) --------------------------------------------------------------------------------
const b64 = (v: object | Buffer) => Buffer.from(v instanceof Buffer ? v : JSON.stringify(v)).toString("base64url");
function sign(payload: object): string {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(payload);
  return `${head}.${body}.${createHmac("sha256", JWT_SECRET).update(`${head}.${body}`).digest("base64url")}`;
}
function verify(token: string): { sub: string } | null {
  const [h, b, s] = token.split(".");
  if (!h || !b || !s) return null;
  const expected = createHmac("sha256", JWT_SECRET).update(`${h}.${b}`).digest();
  const given = Buffer.from(s, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const claims = JSON.parse(Buffer.from(b, "base64url").toString());
  return claims.exp * 1000 > Date.now() ? claims : null;
}

async function createUser(email: string, password: string): Promise<User> {
  const { rows } = await pool.query("insert into auth.users (email) values ($1) returning id", [email]);
  const user = { id: rows[0].id as string, email, password };
  users.set(email, user);
  return user;
}

const userJson = (u: User) => ({ id: u.id, aud: "authenticated", role: "authenticated", email: u.email, email_confirmed_at: "2026-01-01T00:00:00Z", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" });
function sessionFor(u: User) {
  const now = Math.floor(Date.now() / 1000);
  const refresh = randomUUID();
  refreshTokens.set(refresh, u.id);
  return {
    access_token: sign({ sub: u.id, email: u.email, role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600, session_id: randomUUID() }),
    token_type: "bearer", expires_in: 3600, expires_at: now + 3600, refresh_token: refresh, user: userJson(u),
  };
}

// ---- HTTP helpers --------------------------------------------------------------------------------
type Req = { method: string; url: URL; headers: http.IncomingHttpHeaders; body: unknown };
type Res = { status: number; body?: unknown; headers?: Record<string, string> };

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw new HttpError(400, { code: "PGRST100", message: `invalid identifier ${s}` });
  return `"${s}"`;
};
class HttpError extends Error {
  constructor(public status: number, public payload: unknown) { super("http"); }
}

type Principal = { role: "anon" | "authenticated" | "service_role"; sub?: string };
function principal(req: Req): Principal {
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!token || token === ANON_KEY) return { role: "anon" };
  if (token === SERVICE_KEY) return { role: "service_role" };
  const claims = verify(token);
  if (!claims) throw new HttpError(401, { code: "PGRST301", message: "JWT expired or invalid" });
  return { role: "authenticated", sub: claims.sub };
}

async function asPrincipal<T>(p: Principal, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${p.role}`);
    if (p.sub) await client.query("select set_config('request.jwt.claim.sub', $1, true)", [p.sub]);
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

function pgError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  const err = e as { code?: string; message?: string; detail?: string; hint?: string };
  const status = err.code === "42501" ? 403 : err.code === "23505" || err.code === "23503" ? 409 : err.code === "42883" ? 404 : 400;
  return new HttpError(status, { code: err.code ?? "XX000", message: err.message ?? "error", details: err.detail ?? null, hint: err.hint ?? null });
}

// ---- PostgREST subset ---------------------------------------------------------------------------
async function rpc(req: Req, fn: string): Promise<Res> {
  const args = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const names = Object.keys(args).map(ident);
  const data = await asPrincipal(principal(req), async (c) => {
    const meta = await c.query("select p.proretset, pg_get_function_arguments(p.oid) as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1 limit 1", [fn]);
    if (!meta.rows[0]) throw new HttpError(404, { code: "PGRST202", message: `Could not find the function public.${fn}` });
    const types = Object.fromEntries(String(meta.rows[0].sig).split(/,\s+(?=p_)/).map((s) => s.trim().split(/\s+/)).map(([n, t]) => [n, t]));
    const params = Object.entries(args).map(([k, v]) => (types[k] === "jsonb" && v !== null && typeof v === "object" ? JSON.stringify(v) : v));
    const call = `public.${ident(fn)}(${names.map((n, i) => `${n.replaceAll('"', "")} => $${i + 1}`).join(", ")})`;
    const sql = meta.rows[0].proretset ? `select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) as data from (select * from ${call}) t` : `select ${call} as data`;
    return (await c.query(sql, params)).rows[0].data;
  }).catch((e) => { throw pgError(e); });
  return { status: 200, body: data };
}

const OPS: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
function where(url: URL, params: unknown[]): string {
  const parts: string[] = [];
  for (const [key, raw] of url.searchParams) {
    if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(key)) continue;
    const [op, ...rest] = raw.split(".");
    const value = rest.join(".");
    if (op === "is") parts.push(`${ident(key)} is ${value === "null" ? "null" : value === "true" ? "true" : "false"}`);
    else if (op === "in") {
      const list = value.replace(/^\(|\)$/g, "").split(",").map((s) => s.replace(/^"|"$/g, ""));
      params.push(list);
      parts.push(`${ident(key)} = any($${params.length})`);
    } else if (OPS[op]) {
      params.push(value);
      parts.push(`${ident(key)} ${OPS[op]} $${params.length}`);
    } else throw new HttpError(400, { code: "PGRST100", message: `unsupported filter ${key}=${raw}` });
  }
  return parts.length ? ` where ${parts.join(" and ")}` : "";
}
function selectList(url: URL): string {
  const sel = (url.searchParams.get("select") ?? "*").replace(/\s+/g, "");
  if (sel === "*") return "*";
  if (sel.includes("(")) throw new HttpError(400, { code: "PGRST100", message: "embedded selects are not supported by the emulator" });
  return sel.split(",").map(ident).join(", ");
}

async function table(req: Req, name: string): Promise<Res> {
  const t = `public.${ident(name)}`;
  const wantObject = (req.headers.accept ?? "").includes("vnd.pgrst.object");
  const prefer = String(req.headers.prefer ?? "");
  const asObject = (rows: unknown[]): Res => {
    if (wantObject && rows.length !== 1) return { status: 406, body: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `The result contains ${rows.length} rows`, hint: null } };
    return { status: 200, body: wantObject ? rows[0] : rows };
  };
  try {
    return await asPrincipal(principal(req), async (c): Promise<Res> => {
      const params: unknown[] = [];
      if (req.method === "GET" || req.method === "HEAD") {
        const w = where(req.url, params);
        let sql = `select ${selectList(req.url)} from ${t}${w}`;
        const order = req.url.searchParams.get("order");
        if (order) sql += ` order by ${order.split(",").map((o) => { const [col, dir] = o.split("."); return `${ident(col)} ${dir === "desc" ? "desc" : "asc"}`; }).join(", ")}`;
        const limit = Number(req.url.searchParams.get("limit"));
        if (limit > 0) sql += ` limit ${Math.floor(limit)}`;
        const rows = req.method === "HEAD" ? [] : (await c.query(sql, params)).rows;
        const headers: Record<string, string> = {};
        if (prefer.includes("count=exact")) {
          const total = Number((await c.query(`select count(*) n from ${t}${w}`, params)).rows[0].n);
          headers["Content-Range"] = `${rows.length ? `0-${rows.length - 1}` : "*"}/${total}`;
        }
        return req.method === "HEAD" ? { status: 200, headers } : { ...asObject(rows), headers };
      }
      if (req.method === "POST") {
        const items = (Array.isArray(req.body) ? req.body : [req.body]) as Record<string, unknown>[];
        const cols = Object.keys(items[0] ?? {});
        const values = items.map((item) => `(${cols.map((k) => { params.push(item[k]); return `$${params.length}`; }).join(", ")})`).join(", ");
        const ret = prefer.includes("return=representation") ? ` returning ${selectList(req.url)}` : "";
        const rows = (await c.query(`insert into ${t} (${cols.map(ident).join(", ")}) values ${values}${ret}`, params)).rows;
        const res = ret ? asObject(rows) : { status: 201 };
        return { ...res, status: 201 };
      }
      if (req.method === "PATCH") {
        const body = req.body as Record<string, unknown>;
        const sets = Object.keys(body).map((k) => { params.push(body[k]); return `${ident(k)} = $${params.length}`; });
        const w = where(req.url, params);
        const ret = prefer.includes("return=representation") ? ` returning ${selectList(req.url)}` : "";
        const rows = (await c.query(`update ${t} set ${sets.join(", ")}${w}${ret}`, params)).rows;
        return ret ? asObject(rows) : { status: 204 };
      }
      throw new HttpError(405, { code: "PGRST", message: "method not allowed" });
    });
  } catch (e) {
    throw pgError(e);
  }
}

// ---- GoTrue subset ------------------------------------------------------------------------------
async function auth(req: Req, path: string): Promise<Res> {
  const body = (req.body ?? {}) as Record<string, string>;
  if (path === "token") {
    const grant = req.url.searchParams.get("grant_type");
    if (grant === "password") {
      const u = users.get(String(body.email ?? "").toLowerCase());
      if (!u || u.password !== body.password) return { status: 400, body: { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" } };
      return { status: 200, body: sessionFor(u) };
    }
    if (grant === "refresh_token") {
      const id = refreshTokens.get(String(body.refresh_token));
      const u = [...users.values()].find((x) => x.id === id);
      if (!u) return { status: 400, body: { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" } };
      refreshTokens.delete(String(body.refresh_token));
      return { status: 200, body: sessionFor(u) };
    }
  }
  if (path === "user") {
    const claims = verify((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    const u = claims && [...users.values()].find((x) => x.id === claims.sub);
    return u ? { status: 200, body: userJson(u) } : { status: 401, body: { code: 401, error_code: "bad_jwt", msg: "invalid JWT" } };
  }
  if (path === "logout") return { status: 204 };
  if (path === "signup") {
    // Real Supabase emails a confirmation link; the emulator cannot, so it creates an unconfirmed-looking user and says so.
    const email = String(body.email ?? "").toLowerCase();
    const u = users.get(email) ?? (await createUser(email, String(body.password ?? "")));
    return { status: 200, body: { ...userJson(u), email_confirmed_at: null, confirmation_sent_at: new Date().toISOString(), identities: [{}] } };
  }
  if (path === "recover") return { status: 200, body: {} };
  return { status: 404, body: { msg: `emulator: unsupported auth route ${path}` } };
}

// ---- Anthropic stub ----------------------------------------------------------------------------
// POST /anthropic/v1/messages. The app's Anthropic SDK honours ANTHROPIC_BASE_URL, so the local stack points it here.
// This is NOT a model: it deterministically cites the first two <event id="..."> blocks it was shown, which is enough to
// exercise the real route, prompt building, citation verification, persistence and UI in a browser.
function anthropic(req: Req): Res {
  const body = req.body as { messages?: { content?: string }[]; model?: string };
  const prompt = String(body?.messages?.[0]?.content ?? "");
  const ids = [...prompt.matchAll(/<event id="([0-9a-f-]{36})"/g)].map((m) => m[1]).slice(0, 2);
  const answer = {
    summary: "STUB ANALYSIS (local emulator, not a language model): the incident's stored events share one failure site.",
    hypotheses: ids.length
      ? [{ title: "A shared code path produces every event", explanation: "The cited events carry the same error type and stack frames.", confidence: "medium", evidence: ids.map((id) => ({ event_id: id, why: "Same failure site as the incident title." })) }]
      : [],
    recommended_steps: [{ step: "Open the top stack frame and read the surrounding code", rationale: "Both cited events point there." }],
    missing_information: ["Source code and deploy history are not visible to the analysis."],
    limitations: ["Produced by the local emulator's deterministic stub, not a model."],
  };
  return { status: 200, body: { id: "msg_stub", type: "message", role: "assistant", model: body?.model ?? "stub", stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: Math.ceil(prompt.length / 4), output_tokens: 180 }, content: [{ type: "text", text: JSON.stringify(answer) }] } };
}

// ---- server -------------------------------------------------------------------------------------
const server = http.createServer(async (rq, rs) => {
  const chunks: Buffer[] = [];
  for await (const c of rq) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString();
  const url = new URL(rq.url ?? "/", `http://${rq.headers.host}`);
  let body: unknown;
  try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
  const req: Req = { method: rq.method ?? "GET", url, headers: rq.headers, body };
  let res: Res;
  try {
    if (url.pathname === "/emulator/health") res = { status: 200, body: { ok: true } };
    else if (url.pathname === "/anthropic/v1/messages" && req.method === "POST") res = anthropic(req);
    else if (url.pathname.startsWith("/auth/v1/")) res = await auth(req, url.pathname.slice("/auth/v1/".length));
    else if (url.pathname.startsWith("/rest/v1/rpc/")) res = await rpc(req, url.pathname.slice("/rest/v1/rpc/".length));
    else if (url.pathname.startsWith("/rest/v1/")) res = await table(req, url.pathname.slice("/rest/v1/".length));
    else res = { status: 404, body: { message: "emulator: not found" } };
  } catch (e) {
    const err = pgError(e);
    res = { status: err.status, body: err.payload };
  }
  rs.writeHead(res.status, { "content-type": "application/json", ...(res.headers ?? {}) });
  rs.end(req.method === "HEAD" || res.body === undefined ? undefined : JSON.stringify(res.body));
});

// Seed confirmed users: EMULATOR_USERS="email:password,..." each gets one project ("checkout-web", production),
// so the signed-in app opens on the dashboard. EMULATOR_FRESH_USERS get no project (they see onboarding).
for (const entry of (process.env.EMULATOR_USERS ?? "e2e@tracepilot.test:Tracepilot-E2E-1").split(",")) {
  const [email, password] = entry.split(":");
  if (!email || !password) continue;
  const u = await createUser(email.toLowerCase(), password);
  await pool.query("insert into public.projects (owner_id, name, environment) values ($1, 'checkout-web', 'production')", [u.id]);
}
for (const entry of (process.env.EMULATOR_FRESH_USERS ?? "fresh@tracepilot.test:Tracepilot-E2E-1").split(",")) {
  const [email, password] = entry.split(":");
  if (email && password) await createUser(email.toLowerCase(), password);
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[emulator] listening on http://127.0.0.1:${PORT} (embedded Postgres on port ${db.port}, ${users.size} user(s))`);
  console.log(`[emulator] anon key: ${ANON_KEY}   service key: ${SERVICE_KEY}`);
});

async function shutdown() {
  server.close();
  await pool.end().catch(() => undefined);
  await db.stop().catch(() => undefined);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
