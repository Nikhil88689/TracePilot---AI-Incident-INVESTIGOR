// Repeatable ingestion benchmark over real HTTP: POST /api/v1/events against a running TracePilot.
//
//   BASE=http://localhost:3300 SUPABASE=http://127.0.0.1:54321 EMAIL=... PASSWORD=... \
//   EVENTS=3000 CONCURRENCY=16 KEYS=10 BATCH=1 node scripts/bench-ingest.mjs
//
// It signs in through the (emulated) auth endpoint, mints KEYS project API keys (so the per-key limit of 600
// events/minute does not dominate), then sends EVENTS events with CONCURRENCY requests in flight, spread over
// five distinct error shapes (so incident grouping is exercised, not just inserts).
// It reports what was measured and nothing else: it does not know about your hardware or network beyond what it prints.
// Works against the local emulator (it mints keys via PostgREST). For a real deployment mint the keys in the
// dashboard and pass them as API_KEYS=tp_live_a,tp_live_b.
import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import { performance } from "node:perf_hooks";

const BASE = process.env.BASE ?? "http://localhost:3300";
const EVENTS = Number(process.env.EVENTS ?? 3000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 16);
const BATCH = Number(process.env.BATCH ?? 1);
const KEYS = Number(process.env.KEYS ?? 10);

async function mintKeys() {
  if (process.env.API_KEYS) return process.env.API_KEYS.split(",");
  const sb = process.env.SUPABASE ?? "http://127.0.0.1:54321";
  const apikey = process.env.SUPABASE_KEY ?? "emulator-anon-key";
  const login = await fetch(`${sb}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { "content-type": "application/json", apikey },
    body: JSON.stringify({ email: process.env.EMAIL, password: process.env.PASSWORD }),
  }).then((r) => r.json());
  const headers = { "content-type": "application/json", apikey, authorization: `Bearer ${login.access_token}`, prefer: "return=representation" };
  const [project] = await fetch(`${sb}/rest/v1/projects?select=id&limit=1`, { headers }).then((r) => r.json());
  const keys = [];
  for (let i = 0; i < KEYS; i++) {
    const key = `tp_live_${randomBytes(32).toString("base64url")}`;
    const res = await fetch(`${sb}/rest/v1/api_keys?select=id`, {
      method: "POST", headers,
      body: JSON.stringify({ project_id: project.id, name: `bench-${i}`, key_prefix: key.slice(0, 12), key_hash: createHash("sha256").update(key).digest("hex") }),
    });
    if (!res.ok) throw new Error(`could not mint key: ${res.status} ${await res.text()}`);
    keys.push(key);
  }
  return keys;
}

const SHAPES = [
  ["TypeError", "Cannot read properties of undefined (reading 'items')", "/api/cart"],
  ["DatabaseTimeoutError", "timeout acquiring connection from pool", "/api/checkout"],
  ["ValidationError", "email is required", "/api/signup"],
  ["RangeError", "Maximum call stack size exceeded", "/api/report"],
  ["HttpError", "upstream returned 502", "/api/search"],
];
const run = randomBytes(4).toString("hex");
let seq = 0;
const makeEvent = () => {
  const n = seq++;
  const [event_type, message, endpoint] = SHAPES[n % SHAPES.length];
  return { external_event_id: `bench-${run}-${n}`, event_type, level: "error", message, endpoint, stack_trace: `${event_type}: ${message}\n    at handler (/app/${endpoint.slice(5)}.ts:${10 + (n % 5)}:7)`, occurred_at: new Date().toISOString(), attributes: { bench: true } };
};

const keys = await mintKeys();
const requests = Math.ceil(EVENTS / BATCH);
const latencies = [];
const statuses = new Map();
let accepted = 0;
let duplicates = 0;
let next = 0;

async function worker() {
  while (next < requests) {
    const i = next++;
    const key = keys[i % keys.length];
    const events = Array.from({ length: Math.min(BATCH, EVENTS - i * BATCH) }, makeEvent);
    const body = JSON.stringify(BATCH === 1 ? events[0] : { events });
    const t0 = performance.now();
    let status = 0;
    try {
      const res = await fetch(`${BASE}/api/v1/events`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body });
      status = res.status;
      const json = await res.json().catch(() => ({}));
      if (res.ok) { accepted += json.accepted ?? 0; duplicates += json.duplicates ?? 0; }
    } catch { status = -1; }
    latencies.push(performance.now() - t0);
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
  }
}

const started = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const seconds = (performance.now() - started) / 1000;

const sorted = [...latencies].sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const failed = [...statuses].filter(([s]) => s < 200 || s >= 300).reduce((n, [, c]) => n + c, 0);
const cpus = os.cpus();
console.log(JSON.stringify({
  environment: { os: `${os.type()} ${os.release()}`, cpu: cpus[0]?.model.trim(), logicalCores: cpus.length, memoryGB: Math.round(os.totalmem() / 2 ** 30), node: process.version, target: BASE },
  workload: { events: EVENTS, eventsPerRequest: BATCH, requests, concurrency: CONCURRENCY, apiKeys: keys.length, distinctErrorShapes: SHAPES.length },
  results: {
    durationSeconds: Number(seconds.toFixed(2)),
    requestsPerSecond: Number((requests / seconds).toFixed(1)),
    eventsPerSecond: Number((accepted / seconds).toFixed(1)),
    latencyMs: { min: Number(sorted[0].toFixed(1)), p50: Number(pct(50).toFixed(1)), p90: Number(pct(90).toFixed(1)), p95: Number(pct(95).toFixed(1)), p99: Number(pct(99).toFixed(1)), max: Number(sorted.at(-1).toFixed(1)) },
    statusCodes: Object.fromEntries(statuses),
    serverReportedAccepted: accepted,
    serverReportedDuplicates: duplicates,
    errorRatePercent: Number(((failed / requests) * 100).toFixed(2)),
  },
}, null, 2));
