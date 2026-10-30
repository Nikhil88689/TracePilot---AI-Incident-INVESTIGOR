import { randomUUID } from "node:crypto";
import { LIMITS, clean, isValidEventId, sanitizeAttributes } from "./sanitize.js";

export type Level = "debug" | "info" | "warning" | "error" | "fatal";

export interface TracePilotOptions {
  /** Project ingestion key (`tp_live_...`). Without it the client is a harmless no-op. */
  apiKey?: string;
  /** Base URL of your TracePilot deployment, or the full `/api/v1/events` URL. */
  endpoint?: string;
  /** Added to every event's attributes. */
  environment?: string;
  /** Added to every event's attributes (e.g. a git SHA). */
  release?: string;
  /** How long to wait for more events before sending a partial batch. Default 2000. */
  flushIntervalMs?: number;
  /** Events per request (1-50). Default 20. */
  maxBatchSize?: number;
  /** Events held in memory. Further events are dropped, never buffered without bound. Default 100. */
  maxQueueSize?: number;
  /** Per-request timeout. Default 5000. */
  timeoutMs?: number;
  /** Retries after a network error, timeout, 429 or 5xx. Default 2. */
  maxRetries?: number;
  /** Called with SDK problems (dropped events, rejected requests). Exceptions thrown here are swallowed. */
  onError?: (error: Error) => void;
  /** Set false to disable sending entirely (e.g. in tests). Default true. */
  enabled?: boolean;
  /** Custom fetch (tests, proxies). Defaults to the global fetch. */
  fetch?: typeof fetch;
}

export interface CaptureOptions {
  /** The route or operation that failed, e.g. "/api/checkout". */
  endpoint?: string;
  level?: Level;
  /** Structured context. Sanitized (depth/size limited) before sending. */
  attributes?: Record<string, unknown>;
  /** Overrides the per-event environment. */
  environment?: string;
  /** Your own idempotency key. Re-sending the same id is ignored by the server. */
  eventId?: string;
  /** Custom grouping key: events sharing it land in one incident. */
  fingerprint?: string;
  /** When it happened. Default: now. */
  timestamp?: Date;
}

type WireEvent = {
  external_event_id: string;
  event_type: string;
  level: Level;
  message: string;
  occurred_at: string;
  endpoint?: string;
  stack_trace?: string;
  attributes?: Record<string, unknown>;
  fingerprint?: string;
};

const SDK_VERSION = "0.1.0";
const MAX_RETRY_DELAY_MS = 10_000;
const LEVELS = new Set<Level>(["debug", "info", "warning", "error", "fatal"]);

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

function resolveUrl(endpoint: string): URL {
  const url = new URL(endpoint);
  if (!/\/api\/v1\/events\/?$/.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/v1/events`;
  }
  return url;
}

/**
 * Batching, non-blocking error reporter.
 *
 * Guarantees:
 *  - capture* never throws and never awaits the network: it enqueues and returns.
 *  - memory is bounded (maxQueueSize); overflow drops events and reports via onError.
 *  - every network call has a timeout; flush()/close() have an overall deadline and never reject.
 *  - failures are retried with backoff; retries are safe because event ids make delivery idempotent.
 *  - timers are unref'd, so the SDK never keeps your process alive by itself.
 *
 * Limitations: delivery is best effort. A hard crash (SIGKILL, power loss) loses queued
 * events; in-memory queue only, no disk persistence. Call `await client.close()` on shutdown.
 */
export class TracePilot {
  private readonly url: URL | null;
  private readonly apiKey: string;
  private readonly opts: Required<Pick<TracePilotOptions, "flushIntervalMs" | "maxBatchSize" | "maxQueueSize" | "timeoutMs" | "maxRetries">>;
  private readonly defaults: { environment?: string; release?: string };
  private readonly fetchImpl: typeof fetch;
  private readonly onErrorCb?: (error: Error) => void;

  private queue: WireEvent[] = [];
  private readonly inflight = new Set<Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  /** Set once close()'s deadline has passed: in-flight deliveries stop retrying instead of lingering. */
  private abandoned = false;
  private dropped = 0;
  private exitHooked = false;
  private readonly onBeforeExit = () => {
    this.exitHooked = false; // "once" listeners are removed by Node after firing
    void this.flush();
  };

  /** False when the client was configured without a usable key/endpoint (all calls are no-ops). */
  readonly enabled: boolean;

  constructor(options: TracePilotOptions = {}) {
    this.onErrorCb = options.onError;
    this.apiKey = options.apiKey ?? "";
    this.fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
    this.opts = {
      flushIntervalMs: clamp(options.flushIntervalMs, 2_000, 50, 60_000),
      maxBatchSize: clamp(options.maxBatchSize, 20, 1, 50),
      maxQueueSize: clamp(options.maxQueueSize, 100, 1, 10_000),
      timeoutMs: clamp(options.timeoutMs, 5_000, 100, 30_000),
      maxRetries: clamp(options.maxRetries, 2, 0, 5),
    };
    this.defaults = { environment: options.environment, release: options.release };

    let url: URL | null = null;
    if (options.endpoint) {
      try {
        url = resolveUrl(options.endpoint);
      } catch {
        this.report(new Error("TracePilot: `endpoint` is not a valid URL; the client is disabled."));
      }
    }
    this.url = url;
    this.enabled = options.enabled !== false && Boolean(this.apiKey) && url !== null && typeof this.fetchImpl === "function";

    if (!this.enabled && options.enabled !== false && !(url === null && options.endpoint)) {
      this.report(new Error("TracePilot: `apiKey` and `endpoint` are required; the client is disabled."));
    }
  }

  /** Queues an error for delivery. Returns the event id immediately. Never throws. */
  captureError(error: unknown, options: CaptureOptions = {}): string {
    return this.enqueue(() => this.fromError(error, options), options.eventId);
  }

  /** Queues a plain message (default level "info"). Never throws. */
  captureMessage(message: string, options: CaptureOptions = {}): string {
    return this.enqueue(
      () => this.build({ type: "Message", message: String(message), level: options.level ?? "info" }, options),
      options.eventId,
    );
  }

  /**
   * Sends everything queued, waiting at most `timeoutMs` (default 5000) in total.
   * Always resolves, even if the network is down or the server is slow.
   */
  async flush(timeoutMs = 5_000): Promise<void> {
    try {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      this.clearTimer();
      while ((this.queue.length > 0 || this.inflight.size > 0) && Date.now() < deadline) {
        while (this.queue.length > 0 && this.inflight.size < 4) this.startSend();
        await Promise.race([Promise.allSettled([...this.inflight]), sleep(Math.max(1, deadline - Date.now()))]);
      }
    } catch {
      /* flush must never reject */
    }
    if (this.queue.length === 0 && this.inflight.size === 0) this.unhookExit();
  }

  /** Flushes, then stops the client. Later captures are ignored. Safe to call more than once. */
  async close(timeoutMs = 5_000): Promise<void> {
    this.closed = true;
    this.clearTimer();
    await this.flush(timeoutMs);
    this.abandoned = true;
    this.unhookExit();
  }

  /** Events currently waiting to be sent (useful in tests and diagnostics). */
  get pending(): number {
    return this.queue.length;
  }

  // -- internals -----------------------------------------------------------------------

  private enqueue(make: () => WireEvent, requestedId?: string): string {
    // Resolve the id first so callers always get one back, even when disabled or on failure.
    let id = isValidEventId(requestedId) ? requestedId : `evt_${randomUUID()}`;
    try {
      if (!this.enabled || this.closed) return id;
      const event = make();
      event.external_event_id = id = isValidEventId(requestedId) ? requestedId : event.external_event_id;

      if (this.queue.length >= this.opts.maxQueueSize) {
        this.dropped += 1;
        if (this.dropped === 1 || this.dropped % 100 === 0) {
          this.report(new Error(`TracePilot: queue full (${this.opts.maxQueueSize}); dropped ${this.dropped} event(s).`));
        }
        return id;
      }
      this.queue.push(event);
      this.hookExit();
      if (this.queue.length >= this.opts.maxBatchSize) {
        void this.flush(this.opts.timeoutMs * (this.opts.maxRetries + 1));
      } else {
        this.scheduleFlush();
      }
    } catch (error) {
      this.report(toError(error));
    }
    return id;
  }

  private fromError(error: unknown, options: CaptureOptions): WireEvent {
    if (error instanceof Error) {
      const cause = (error as { cause?: unknown }).cause;
      return this.build(
        { type: error.name || "Error", message: error.message || error.name || "Error", stack: error.stack, level: options.level ?? "error" },
        cause === undefined ? options : { ...options, attributes: { cause: describe(cause), ...options.attributes } },
      );
    }
    return this.build(
      { type: typeof error === "string" ? "Error" : "NonErrorThrown", message: describe(error), level: options.level ?? "error" },
      options,
    );
  }

  private build(
    base: { type: string; message: string; stack?: string; level: Level },
    options: CaptureOptions,
  ): WireEvent {
    const attributes = sanitizeAttributes({
      ...(this.defaults.environment || options.environment ? { environment: options.environment ?? this.defaults.environment } : {}),
      ...(this.defaults.release ? { release: this.defaults.release } : {}),
      ...options.attributes,
    });
    const occurred = options.timestamp instanceof Date && !Number.isNaN(options.timestamp.getTime()) ? options.timestamp : new Date();

    const event: WireEvent = {
      external_event_id: `evt_${randomUUID()}`,
      event_type: clean(base.type, LIMITS.eventType) || "Error",
      level: LEVELS.has(base.level) ? base.level : "error",
      message: clean(base.message, LIMITS.message) || "Unknown error",
      occurred_at: occurred.toISOString(),
    };
    if (options.endpoint) event.endpoint = clean(String(options.endpoint), LIMITS.endpoint) || undefined;
    if (base.stack) event.stack_trace = clean(base.stack, LIMITS.stack);
    if (attributes) event.attributes = attributes;
    if (options.fingerprint) event.fingerprint = clean(String(options.fingerprint), 200) || undefined;
    return event;
  }

  /**
   * The flush timer is unref'd, so without this a short-lived script would exit with events
   * still queued. The listener exists only while events are pending, so creating many clients
   * cannot accumulate process listeners.
   */
  private hookExit() {
    if (this.exitHooked || typeof process === "undefined" || typeof process.once !== "function") return;
    process.once("beforeExit", this.onBeforeExit);
    this.exitHooked = true;
  }

  private unhookExit() {
    if (!this.exitHooked || typeof process === "undefined" || typeof process.off !== "function") return;
    process.off("beforeExit", this.onBeforeExit);
    this.exitHooked = false;
  }

  private scheduleFlush() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush(this.opts.timeoutMs * (this.opts.maxRetries + 1));
    }, this.opts.flushIntervalMs);
    this.timer.unref?.();
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private startSend() {
    const batch = this.queue.splice(0, this.opts.maxBatchSize);
    const promise: Promise<void> = this.send(batch)
      .catch((error) => this.report(toError(error)))
      .finally(() => this.inflight.delete(promise));
    this.inflight.add(promise);
  }

  private async send(batch: WireEvent[]): Promise<void> {
    const body = JSON.stringify({ events: batch });
    let lastProblem = "unknown error";

    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      let retryAfterMs: number | undefined;
      try {
        const response = await this.fetchImpl(this.url!, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "User-Agent": `tracepilot-node/${SDK_VERSION}`,
          },
          body,
          signal: AbortSignal.timeout(this.opts.timeoutMs),
          redirect: "error", // never forward the key to a redirect target
        });

        if (response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return;
        }

        const detail = await readErrorDetail(response);
        if (response.status !== 429 && response.status < 500) {
          // Client errors are not retryable: the same payload would fail again.
          this.report(new Error(`TracePilot: server rejected ${batch.length} event(s) (${response.status}${detail}).`));
          return;
        }
        lastProblem = `HTTP ${response.status}${detail}`;
        const header = Number(response.headers.get("retry-after"));
        if (Number.isFinite(header) && header > 0) retryAfterMs = Math.min(header * 1000, MAX_RETRY_DELAY_MS);
      } catch (error) {
        lastProblem = error instanceof Error ? (error.name === "TimeoutError" ? "request timed out" : error.message) : "network error";
      }

      if (this.abandoned) break; // close() already gave up waiting: do not linger on retries
      if (attempt < this.opts.maxRetries) {
        const backoff = Math.min(200 * 2 ** attempt, MAX_RETRY_DELAY_MS) * (0.5 + Math.random() / 2);
        await sleep(retryAfterMs ?? backoff);
      }
    }
    this.report(new Error(`TracePilot: could not deliver ${batch.length} event(s): ${lastProblem}.`));
  }

  private report(error: Error) {
    try {
      this.onErrorCb?.(error);
    } catch {
      /* a faulty callback must not affect the host application */
    }
  }
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.message || value.name;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).slice(0, 2_000);
    const message = (JSON.parse(text) as { error?: { message?: string } }).error?.message;
    return message ? `: ${message}` : "";
  } catch {
    return "";
  }
}
