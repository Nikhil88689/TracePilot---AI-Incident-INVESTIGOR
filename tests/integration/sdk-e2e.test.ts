/**
 * End to end: the real SDK -> real HTTP -> the real route handler -> real Postgres.
 * A tiny node:http server stands in for Next.js; the handler and database are production code.
 */
import http from "node:http";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TracePilot } from "../../sdk/src/index";
import { handleIngest } from "../../src/lib/ingest/handler";
import { generateApiKey } from "../../src/lib/ingest/keys";
import type { IngestStore } from "../../src/lib/ingest/store";
import { adminPool, createUserAndProject, servicePool } from "./pg-harness";
import { createPgIngestStore } from "./pg-store";

const port = Number(process.env.TP_TEST_PG_PORT);
let admin: pg.Pool;
let service: pg.Pool;
let server: http.Server;
let baseUrl: string;
let store: IngestStore;
/** Lets a test make the server misbehave (e.g. fail the first N requests). */
const behavior = { failFirst: 0, seen: 0, delayMs: 0 };

beforeAll(async () => {
  admin = adminPool(port);
  service = servicePool(port, 10);
  store = createPgIngestStore(service);

  server = http.createServer(async (req, res) => {
    behavior.seen += 1;
    if (behavior.delayMs) await new Promise((r) => setTimeout(r, behavior.delayMs));
    if (behavior.seen <= behavior.failFirst) {
      res.writeHead(503, { "content-type": "application/json" }).end('{"error":{"message":"try later"}}');
      return;
    }
    const request = new Request(`http://localhost${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: req.method === "POST" ? (Readable.toWeb(req) as ReadableStream) : undefined,
      // @ts-expect-error Node's fetch requires duplex for streamed bodies
      duplex: "half",
    });
    const response = await handleIngest(request, { store });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await admin.end();
  await service.end();
});

async function project() {
  const { projectId } = await createUserAndProject(admin);
  const { key, prefix, hash } = generateApiKey();
  const { rows } = await admin.query<{ id: string }>(
    "insert into public.api_keys (project_id, name, key_prefix, key_hash) values ($1, 'sdk-e2e', $2, $3) returning id",
    [projectId, prefix, hash],
  );
  return { projectId, key, keyId: rows[0].id };
}

const incidents = async (projectId: string) =>
  (await admin.query("select title, occurrence_count, severity from public.incidents where project_id = $1", [projectId])).rows;
const eventCount = async (projectId: string) =>
  Number((await admin.query("select count(*) n from public.events where project_id = $1", [projectId])).rows[0].n);

describe("TracePilot SDK -> ingestion API -> Postgres", () => {
  it("delivers a captured error and creates an incident", async () => {
    const p = await project();
    const errors: Error[] = [];
    const tp = new TracePilot({ apiKey: p.key, endpoint: baseUrl, environment: "development", onError: (e) => errors.push(e) });

    const id = tp.captureError(new TypeError("Cannot read properties of undefined"), {
      endpoint: "/api/checkout",
      attributes: { userId: 42 },
    });
    await tp.close();

    expect(errors).toEqual([]);
    const { rows } = await admin.query(
      "select external_event_id, event_type, level, endpoint, attributes from public.events where project_id = $1",
      [p.projectId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      external_event_id: id,
      event_type: "TypeError",
      level: "error",
      endpoint: "/api/checkout",
      attributes: { userId: 42, environment: "development" },
    });
    expect(await incidents(p.projectId)).toEqual([
      { title: "TypeError: Cannot read properties of undefined", occurrence_count: 1, severity: "high" },
    ]);
  });

  it("groups a burst of the same failure into one incident across several batches", async () => {
    const p = await project();
    const tp = new TracePilot({ apiKey: p.key, endpoint: baseUrl, maxBatchSize: 10 });
    for (let i = 0; i < 45; i++) tp.captureError(new Error(`Order ${1000 + i} could not be charged`), { endpoint: "/api/charge" });
    await tp.close();

    expect(await eventCount(p.projectId)).toBe(45);
    const rows = await incidents(p.projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0].occurrence_count).toBe(45);
  });

  it("maps levels to severities and keeps distinct errors apart", async () => {
    const p = await project();
    const tp = new TracePilot({ apiKey: p.key, endpoint: baseUrl });
    tp.captureError(new Error("disk full"), { level: "fatal" });
    tp.captureMessage("cache miss ratio high", { level: "warning" });
    tp.captureMessage("deploy complete");
    await tp.close();
    const rows = await incidents(p.projectId);
    expect(rows.map((r) => r.severity).sort()).toEqual(["critical", "low", "medium"]);
  });

  it("is idempotent: retries after a transient 503 do not double count", async () => {
    const p = await project();
    behavior.seen = 0;
    behavior.failFirst = 2;
    const errors: Error[] = [];
    const tp = new TracePilot({ apiKey: p.key, endpoint: baseUrl, maxRetries: 3, onError: (e) => errors.push(e) });
    tp.captureError(new Error("flaky network"));
    await tp.close(15_000);
    behavior.failFirst = 0;

    expect(errors).toEqual([]);
    expect(await eventCount(p.projectId)).toBe(1);
    expect((await incidents(p.projectId))[0].occurrence_count).toBe(1);
  });

  it("re-sending the same custom event id is ignored by the server", async () => {
    const p = await project();
    const tp = new TracePilot({ apiKey: p.key, endpoint: baseUrl });
    tp.captureError(new Error("charge failed"), { eventId: "order-77:charge" });
    tp.captureError(new Error("charge failed"), { eventId: "order-77:charge" });
    await tp.close();
    expect(await eventCount(p.projectId)).toBe(1);
  });

  it("reports a revoked key through onError without throwing, and stores nothing", async () => {
    const p = await project();
    await admin.query("update public.api_keys set revoked_at = now() where id = $1", [p.keyId]);
    const errors: Error[] = [];
    const tp = new TracePilot({ apiKey: p.key, endpoint: baseUrl, onError: (e) => errors.push(e) });
    tp.captureError(new Error("should not land"));
    await expect(tp.close()).resolves.toBeUndefined();
    expect(errors[0].message).toMatch(/rejected.*401/);
    expect(await eventCount(p.projectId)).toBe(0);
  });

  it("is harmless when the server is unreachable: bounded time, no throw", async () => {
    const errors: Error[] = [];
    const tp = new TracePilot({ apiKey: generateApiKey().key, endpoint: "http://127.0.0.1:9", maxRetries: 1, timeoutMs: 500, onError: (e) => errors.push(e) });
    tp.captureError(new Error("nobody is listening"));
    const started = Date.now();
    await expect(tp.close(5_000)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(errors[0].message).toMatch(/could not deliver/);
  });

  it("does not block the host when the server is slow: capture returns instantly, flush is bounded", async () => {
    const p = await project();
    behavior.seen = 0;
    behavior.delayMs = 1_500;
    const tp = new TracePilot({ apiKey: p.key, endpoint: baseUrl, timeoutMs: 5_000 });
    const t0 = Date.now();
    tp.captureError(new Error("slow server"));
    expect(Date.now() - t0).toBeLessThan(50);
    const f0 = Date.now();
    await tp.flush(200);
    expect(Date.now() - f0).toBeLessThan(1_000);
    behavior.delayMs = 0;
    await tp.close(10_000); // let the in-flight request finish so the test leaves nothing behind
  });

  it("sends oversized and hostile payloads in a form the server accepts (sanitised, not rejected)", async () => {
    const p = await project();
    const errors: Error[] = [];
    const tp = new TracePilot({ apiKey: p.key, endpoint: baseUrl, onError: (e) => errors.push(e) });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const err = new Error("x".repeat(9_000) + "\u0000 tail");
    err.stack = "y".repeat(40_000);
    tp.captureError(err, { endpoint: "/e".repeat(400), attributes: { circular, big: BigInt(1), deep: { a: { b: { c: { d: { e: 1 } } } } } } });
    tp.captureError(new Error("a perfectly normal neighbour"));
    await tp.close();
    expect(errors).toEqual([]);
    expect(await eventCount(p.projectId)).toBe(2);
  });
});
