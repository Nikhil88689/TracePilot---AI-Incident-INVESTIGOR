import { createHash } from "node:crypto";
import { INGEST_LIMITS as L } from "./constants";
import { computeFingerprint, incidentTitle, severityForLevel } from "./fingerprint";
import { extractBearerKey, hashApiKey } from "./keys";
import { parseIngestBody, type IngestEvent } from "./schemas";
import type { IngestStore, PreparedEvent } from "./store";

type Deps = { store: IngestStore; now?: () => Date };

const JSON_HEADERS = { "Cache-Control": "no-store" } as const;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...JSON_HEADERS, ...headers } });
}

function error(status: number, code: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return json(status, { error: { code, message, ...extra } }, headers);
}

/** Client IP, hashed: we only need a stable bucket key, not to store addresses. */
function clientBucket(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  return `authfail:${createHash("sha256").update(forwarded).digest("hex").slice(0, 24)}`;
}

/** Reads the body but gives up as soon as it exceeds `max` bytes (does not buffer unbounded input). */
async function readBodyLimited(request: Request, max: number): Promise<{ text: string } | "too_large" | "invalid"> {
  const reader = request.body?.getReader();
  if (!reader) return { text: "" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return "too_large";
    }
    chunks.push(value);
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) };
  } catch {
    return "invalid";
  }
}

function prepare(event: IngestEvent): PreparedEvent {
  return {
    external_event_id: event.external_event_id,
    event_type: event.event_type,
    level: event.level,
    message: event.message,
    stack_trace: event.stack_trace ?? null,
    fingerprint: computeFingerprint(event),
    title: incidentTitle(event),
    severity: severityForLevel(event.level),
    endpoint: event.endpoint ?? null,
    // Normalised to UTC so the database stores one canonical instant.
    occurred_at: new Date(event.occurred_at).toISOString(),
    attributes: event.attributes ?? {},
  };
}

/**
 * POST /api/v1/events. Order matters:
 *   1. cheap checks (content type, declared size)           -> no database work for junk
 *   2. authenticate the project key (hash lookup, revoked keys fail)
 *   3. bounded body read, JSON parse, schema validation
 *   4. per-key rate limit (cost = number of events)
 *   5. atomic processing
 * The project is derived only from the key; any project_id in the body is ignored.
 */
export async function handleIngest(request: Request, { store, now = () => new Date() }: Deps): Promise<Response> {
  const unauthorized = async () => {
    // Throttle credential guessing per client without revealing why the key failed.
    const limit = await store
      .consumeRateLimit(clientBucket(request), 1, L.rateLimitAuthFailuresPerIp, L.rateLimitWindowSeconds)
      .catch(() => null);
    if (limit && !limit.allowed) {
      return error(429, "rate_limited", "Too many failed authentication attempts.", {}, { "Retry-After": String(limit.retryAfter) });
    }
    return error(401, "unauthorized", "Missing or invalid API key.", {}, { "WWW-Authenticate": 'Bearer realm="tracepilot"' });
  };

  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return error(415, "unsupported_media_type", "Content-Type must be application/json.");
  }

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > L.maxBodyBytes) {
    return error(413, "payload_too_large", `Request body may be at most ${L.maxBodyBytes} bytes.`);
  }

  const key = extractBearerKey(request.headers.get("authorization"));
  if (!key) return unauthorized();

  let auth;
  try {
    auth = await store.authenticate(hashApiKey(key));
  } catch (e) {
    return serverError(e);
  }
  if (!auth) return unauthorized();

  const body = await readBodyLimited(request, L.maxBodyBytes);
  if (body === "too_large") {
    return error(413, "payload_too_large", `Request body may be at most ${L.maxBodyBytes} bytes.`);
  }
  if (body === "invalid") return error(400, "invalid_json", "Body must be valid UTF-8 JSON.");

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body.text);
  } catch {
    return error(400, "invalid_json", "Body must be valid JSON.");
  }

  const parsed = parseIngestBody(parsedJson, now());
  if (!parsed.ok) {
    return parsed.reason === "too_many_events"
      ? error(413, "too_many_events", parsed.issues[0].message)
      : error(422, "validation_failed", "The request body is invalid.", { issues: parsed.issues });
  }

  let limit;
  try {
    limit = await store.consumeRateLimit(
      `key:${auth.keyId}`,
      parsed.events.length,
      L.rateLimitEventsPerKey,
      L.rateLimitWindowSeconds,
    );
  } catch (e) {
    return serverError(e);
  }
  const rateHeaders = {
    "X-RateLimit-Limit": String(L.rateLimitEventsPerKey),
    "X-RateLimit-Remaining": String(Math.max(0, L.rateLimitEventsPerKey - limit.count)),
  };
  if (!limit.allowed) {
    return error(429, "rate_limited", "Rate limit exceeded. Retry later.", {}, { ...rateHeaders, "Retry-After": String(limit.retryAfter) });
  }

  try {
    const results = await store.ingest(auth.projectId, parsed.events.map(prepare));
    const accepted = results.filter((r) => r.status === "accepted").length;
    return json(
      accepted > 0 ? 201 : 200,
      { accepted, duplicates: results.length - accepted, results },
      rateHeaders,
    );
  } catch (e) {
    return serverError(e);
  }
}

/** Never echo internals to clients, and never log request data (it may hold secrets). */
function serverError(e: unknown): Response {
  console.error("[ingest] processing failed:", e instanceof Error ? e.message : "unknown error");
  return error(500, "internal_error", "Could not process the request. It is safe to retry.");
}
