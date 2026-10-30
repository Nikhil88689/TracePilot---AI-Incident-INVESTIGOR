// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { TracePilot, type TracePilotOptions } from "./client.js";

const KEY = "tp_live_" + "A".repeat(43);
const URL_BASE = "https://tracepilot.example.com";

type Call = { url: string; init: RequestInit; body: { events: Record<string, unknown>[] } };

function recorder(responder: (call: Call, n: number) => Response | Promise<Response> = () => new Response("{}", { status: 201 })) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const call: Call = { url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body ?? "{}")) };
    calls.push(call);
    return responder(call, calls.length);
  });
  return { calls, fetch: fetchMock as unknown as typeof fetch };
}

function client(opts: Partial<TracePilotOptions> = {}, responder?: Parameters<typeof recorder>[0]) {
  const rec = recorder(responder);
  const errors: Error[] = [];
  const tp = new TracePilot({
    apiKey: KEY,
    endpoint: URL_BASE,
    fetch: rec.fetch,
    onError: (e) => errors.push(e),
    flushIntervalMs: 50,
    ...opts,
  });
  return { tp, errors, ...rec };
}

const fast = { maxRetries: 2 };

describe("configuration", () => {
  it("is a harmless no-op without an apiKey or endpoint, and says so via onError", async () => {
    const rec = recorder();
    const errors: Error[] = [];
    const tp = new TracePilot({ fetch: rec.fetch, onError: (e) => errors.push(e) });
    expect(tp.enabled).toBe(false);
    expect(() => tp.captureError(new Error("x"))).not.toThrow();
    await tp.close();
    expect(rec.calls).toHaveLength(0);
    expect(errors[0]?.message).toMatch(/apiKey.*endpoint.*required/);
  });

  it("does not throw on an invalid endpoint URL", () => {
    const errors: Error[] = [];
    const tp = new TracePilot({ apiKey: KEY, endpoint: "not a url", onError: (e) => errors.push(e) });
    expect(tp.enabled).toBe(false);
    expect(errors[0]?.message).toMatch(/not a valid URL/);
  });

  it("does nothing when explicitly disabled", async () => {
    const { tp, calls } = client({ enabled: false });
    tp.captureError(new Error("x"));
    await tp.close();
    expect(calls).toHaveLength(0);
  });

  it.each([
    [URL_BASE, `${URL_BASE}/api/v1/events`],
    [`${URL_BASE}/`, `${URL_BASE}/api/v1/events`],
    [`${URL_BASE}/api/v1/events`, `${URL_BASE}/api/v1/events`],
    [`${URL_BASE}/tp`, `${URL_BASE}/tp/api/v1/events`],
  ])("resolves endpoint %s", async (endpoint, expected) => {
    const { tp, calls } = client({ endpoint });
    tp.captureError(new Error("x"));
    await tp.close();
    expect(calls[0].url).toBe(expected);
  });
});

describe("capturing", () => {
  it("returns an event id immediately without waiting for the network", () => {
    const { tp, calls } = client({}, () => new Promise<Response>(() => {})); // never resolves
    const id = tp.captureError(new Error("slow"));
    expect(id).toMatch(/^evt_[0-9a-f-]{36}$/);
    expect(tp.pending).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("sends a well-formed batch with auth headers after flush", async () => {
    const { tp, calls } = client({ environment: "staging", release: "1.2.3" });
    const err = new TypeError("Cannot read properties of undefined");
    const id = tp.captureError(err, { endpoint: "/api/checkout", attributes: { userId: 7 } });
    await tp.flush();

    expect(calls).toHaveLength(1);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(calls[0].init.redirect).toBe("error");

    const [event] = calls[0].body.events;
    expect(event).toMatchObject({
      external_event_id: id,
      event_type: "TypeError",
      level: "error",
      message: "Cannot read properties of undefined",
      endpoint: "/api/checkout",
      attributes: { userId: 7, environment: "staging", release: "1.2.3" },
    });
    expect(event.stack_trace).toContain("TypeError");
    expect(new Date(event.occurred_at as string).toISOString()).toBe(event.occurred_at);
  });

  it("never puts the API key in the event payload", async () => {
    const { tp, calls } = client();
    tp.captureError(new Error("x"));
    await tp.flush();
    expect(JSON.stringify(calls[0].body)).not.toContain(KEY);
  });

  it("lets the per-event environment override the client default", async () => {
    const { tp, calls } = client({ environment: "production" });
    tp.captureError(new Error("x"), { environment: "development" });
    await tp.flush();
    expect(calls[0].body.events[0].attributes).toMatchObject({ environment: "development" });
  });

  it("captures messages with a level, and non-Error values", async () => {
    const { tp, calls } = client();
    tp.captureMessage("deploy finished", { level: "info" });
    tp.captureError("a string was thrown");
    tp.captureError({ code: 42 });
    tp.captureError(undefined);
    await tp.flush();
    const events = calls.flatMap((c) => c.body.events);
    expect(events.map((e) => e.message)).toEqual(["deploy finished", "a string was thrown", '{"code":42}', "undefined"]);
    expect(events[0]).toMatchObject({ level: "info", event_type: "Message" });
    expect(events[2].event_type).toBe("NonErrorThrown");
  });

  it("records an error's cause", async () => {
    const { tp, calls } = client();
    tp.captureError(new Error("outer", { cause: new Error("root cause") }));
    await tp.flush();
    expect(calls[0].body.events[0].attributes).toMatchObject({ cause: "root cause" });
  });

  it("honours a custom event id, fingerprint and timestamp; ignores an invalid id", async () => {
    const { tp, calls } = client();
    const at = new Date("2026-10-29T10:00:00Z");
    expect(tp.captureError(new Error("a"), { eventId: "order-1:failure", fingerprint: "checkout", timestamp: at })).toBe("order-1:failure");
    const generated = tp.captureError(new Error("b"), { eventId: "has spaces!" });
    expect(generated).toMatch(/^evt_/);
    await tp.flush();
    expect(calls[0].body.events[0]).toMatchObject({ external_event_id: "order-1:failure", fingerprint: "checkout", occurred_at: at.toISOString() });
  });
});

describe("sanitizing events so one bad event cannot reject a whole batch", () => {
  it("truncates oversized fields and strips NUL characters", async () => {
    const { tp, calls } = client();
    const err = new Error("m".repeat(10_000) + "\u0000");
    err.stack = "s".repeat(50_000);
    tp.captureError(err, { endpoint: "/e".repeat(500) });
    await tp.flush();
    const [e] = calls[0].body.events;
    expect((e.message as string).length).toBe(4000);
    expect((e.stack_trace as string).length).toBe(20000);
    expect((e.endpoint as string).length).toBe(300);
    expect(JSON.stringify(e)).not.toContain("\\u0000");
  });

  it("handles circular, bigint, function and throwing-getter attributes", async () => {
    const { tp, calls } = client();
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    const hostile = {
      get boom() {
        throw new Error("getter exploded");
      },
    };
    tp.captureError(new Error("x"), { attributes: { circular, big: BigInt(10), fn: () => 1, ok: "yes", hostile } });
    await tp.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].body.events[0].attributes).toBeUndefined(); // the throwing getter makes the whole object unusable
  });

  it("keeps good attributes when only circular/bigint/function values are present", async () => {
    const { tp, calls } = client();
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    tp.captureError(new Error("x"), { attributes: { circular, big: BigInt(10), fn: () => 1, ok: "yes" } });
    await tp.flush();
    expect(calls[0].body.events[0].attributes).toEqual({ circular: { name: "loop", self: "[Circular]" }, big: "10", ok: "yes" });
  });

  it("limits nesting depth to what the server accepts", async () => {
    const { tp, calls } = client();
    tp.captureError(new Error("x"), { attributes: { a: { b: { c: { d: { e: { f: 1 } } } } } } });
    await tp.flush();
    expect(JSON.stringify(calls[0].body.events[0].attributes)).toContain("[Truncated]");
  });

  it("replaces attributes that exceed the size limit instead of sending an invalid event", async () => {
    const { tp, calls } = client();
    const big = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, "x".repeat(1_900)]));
    tp.captureError(new Error("x"), { attributes: big });
    await tp.flush();
    expect(calls[0].body.events[0].attributes).toHaveProperty("attributes_dropped");
  });
});

describe("batching", () => {
  it("sends immediately when a full batch is queued, in batch-size chunks", async () => {
    const { tp, calls } = client({ maxBatchSize: 5, flushIntervalMs: 60_000 });
    for (let i = 0; i < 12; i++) tp.captureError(new Error(`e${i}`));
    await tp.flush();
    expect(calls.map((c) => c.body.events.length).sort()).toEqual([2, 5, 5]);
  });

  it("flushes a partial batch on the interval without an explicit flush", async () => {
    const { tp, calls } = client({ flushIntervalMs: 50 });
    tp.captureError(new Error("lonely"));
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 2000 });
    await tp.close();
  });

  it("does not let the flush timer keep the process alive (timer is unref'd)", async () => {
    const { tp } = client({ flushIntervalMs: 60_000 });
    tp.captureError(new Error("x"));
    const timers = (tp as unknown as { timer?: { hasRef?: () => boolean } }).timer;
    expect(timers?.hasRef?.()).toBe(false);
    await tp.close();
  });
});

describe("failure handling", () => {
  it("retries 5xx and succeeds, reusing the same event id (safe because delivery is idempotent)", async () => {
    const { tp, calls, errors } = client({ ...fast }, (_c, n) => new Response("{}", { status: n < 3 ? 503 : 201 }));
    const id = tp.captureError(new Error("flaky"));
    await tp.flush(10_000);
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.body.events[0].external_event_id))).toEqual(new Set([id]));
    expect(errors).toHaveLength(0);
  });

  it("gives up after maxRetries and reports once, without throwing", async () => {
    const { tp, calls, errors } = client({ maxRetries: 1 }, () => new Response("{}", { status: 500 }));
    tp.captureError(new Error("x"));
    await tp.flush(10_000);
    expect(calls).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/could not deliver 1 event.*HTTP 500/);
  });

  it("honours Retry-After on 429 (capped) before retrying", async () => {
    const started = Date.now();
    const { tp, calls } = client(
      { maxRetries: 1 },
      (_c, n) => (n === 1 ? new Response("{}", { status: 429, headers: { "retry-after": "1" } }) : new Response("{}", { status: 201 })),
    );
    tp.captureError(new Error("x"));
    await tp.flush(10_000);
    expect(calls).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it.each([400, 401, 413, 422])("does not retry a %i, and surfaces the server's message", async (status) => {
    const { tp, calls, errors } = client(
      {},
      () => new Response(JSON.stringify({ error: { message: "nope" } }), { status }),
    );
    tp.captureError(new Error("x"));
    await tp.flush();
    expect(calls).toHaveLength(1);
    expect(errors[0].message).toContain(String(status));
    expect(errors[0].message).toContain("nope");
  });

  it("never throws or rejects when the network fails", async () => {
    const errors: Error[] = [];
    const tp = new TracePilot({
      apiKey: KEY,
      endpoint: URL_BASE,
      maxRetries: 1,
      onError: (e) => errors.push(e),
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    tp.captureError(new Error("x"));
    await expect(tp.flush(10_000)).resolves.toBeUndefined();
    expect(errors[0].message).toMatch(/fetch failed/);
  });

  it("times out a hanging request and does not block the host", async () => {
    const hanging = ((_u: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof fetch;
    const errors: Error[] = [];
    const tp = new TracePilot({ apiKey: KEY, endpoint: URL_BASE, timeoutMs: 100, maxRetries: 0, fetch: hanging, onError: (e) => errors.push(e) });
    tp.captureError(new Error("x"));
    const started = Date.now();
    await tp.flush(5_000);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(errors[0].message).toMatch(/timed out/);
  });

  it("bounds flush() by its own deadline even if the server never answers", async () => {
    const never = (() => new Promise(() => {})) as unknown as typeof fetch;
    const tp = new TracePilot({ apiKey: KEY, endpoint: URL_BASE, timeoutMs: 30_000, fetch: never });
    tp.captureError(new Error("x"));
    const started = Date.now();
    await tp.flush(150);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("drops events beyond maxQueueSize and reports it, keeping memory bounded", () => {
    const { tp, errors } = client({ maxQueueSize: 3, maxBatchSize: 50, flushIntervalMs: 60_000 });
    for (let i = 0; i < 10; i++) tp.captureError(new Error(`e${i}`));
    expect(tp.pending).toBe(3);
    expect(errors[0].message).toMatch(/queue full/);
    void tp.close(1);
  });

  it("survives a throwing onError callback", async () => {
    const tp = new TracePilot({
      apiKey: KEY,
      endpoint: URL_BASE,
      maxRetries: 0,
      onError: () => {
        throw new Error("callback bug");
      },
      fetch: (async () => new Response("{}", { status: 500 })) as typeof fetch,
    });
    tp.captureError(new Error("x"));
    await expect(tp.flush()).resolves.toBeUndefined();
  });
});

describe("close()", () => {
  it("flushes pending events, then ignores later captures", async () => {
    const { tp, calls } = client({ flushIntervalMs: 60_000 });
    tp.captureError(new Error("before"));
    await tp.close();
    expect(calls).toHaveLength(1);
    tp.captureError(new Error("after"));
    await tp.close(); // idempotent
    expect(calls).toHaveLength(1);
    expect(tp.pending).toBe(0);
  });
});

describe("close() with a flaky server", () => {
  it("keeps retrying during the close window, so shutdown does not lose events to a transient 503", async () => {
    const { tp, calls, errors } = client({ maxRetries: 3, flushIntervalMs: 60_000 }, (_c, n) => new Response("{}", { status: n < 3 ? 503 : 201 }));
    tp.captureError(new Error("last words"));
    await tp.close(10_000);
    expect(calls).toHaveLength(3);
    expect(errors).toEqual([]);
  });

  it("stops retrying once the close deadline has passed", async () => {
    const { tp, calls } = client({ maxRetries: 5 }, () => new Response("{}", { status: 503 }));
    tp.captureError(new Error("x"));
    await tp.close(50); // far shorter than the backoff schedule
    const seen = calls.length;
    await new Promise((r) => setTimeout(r, 1_500));
    expect(calls.length).toBeLessThanOrEqual(seen + 1); // at most the attempt already in progress
  });
});

describe("process hooks", () => {
  it("holds a beforeExit listener only while events are pending (no listener leak across many clients)", async () => {
    const before = process.listenerCount("beforeExit");
    const previousMax = process.getMaxListeners();
    process.setMaxListeners(before + 40); // this test deliberately holds 25 pending clients at once
    const clients = Array.from({ length: 25 }, () => client({ flushIntervalMs: 60_000 }));
    expect(process.listenerCount("beforeExit")).toBe(before); // idle clients register nothing
    clients.forEach(({ tp }) => tp.captureError(new Error("x")));
    expect(process.listenerCount("beforeExit")).toBe(before + 25);
    await Promise.all(clients.map(({ tp }) => tp.close()));
    expect(process.listenerCount("beforeExit")).toBe(before);
    process.setMaxListeners(previousMax);
  });
});

describe("option clamping", () => {
  it("coerces out-of-range options instead of failing", async () => {
    const { tp, calls } = client({ maxBatchSize: 9_999, maxRetries: -5, timeoutMs: Number.NaN });
    for (let i = 0; i < 60; i++) tp.captureError(new Error("x"));
    await tp.flush();
    expect(Math.max(...calls.map((c) => c.body.events.length))).toBeLessThanOrEqual(50);
  });
});
