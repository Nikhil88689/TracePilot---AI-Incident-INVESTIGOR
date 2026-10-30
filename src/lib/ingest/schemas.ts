import { z } from "zod";
import { EVENT_LEVELS, INGEST_LIMITS as L } from "./constants";

const hasNul = (value: string) => value.includes("\u0000");
/** Postgres text/jsonb cannot store NUL; reject it up front rather than failing the whole batch with a 500. */
const noNul = (value: string) => !hasNul(value);

function jsonDepth(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  const children = Array.isArray(value) ? value : Object.values(value);
  return 1 + children.reduce<number>((max, child) => Math.max(max, jsonDepth(child)), 0);
}

const attributesSchema = z
  .record(z.string().max(100), z.json())
  .refine((a) => Object.keys(a).length <= L.maxAttributeKeys, `attributes may have at most ${L.maxAttributeKeys} keys`)
  .refine((a) => jsonDepth(a) <= L.maxAttributesDepth, `attributes may be nested at most ${L.maxAttributesDepth} levels`)
  .refine(
    (a) => Buffer.byteLength(JSON.stringify(a), "utf8") <= L.maxAttributesBytes,
    `attributes may be at most ${L.maxAttributesBytes} bytes when serialized`,
  )
  .refine((a) => !JSON.stringify(a).includes("\\u0000"), "attributes must not contain NUL characters");

function timestampSchema(now: Date) {
  return z.iso
    .datetime({ offset: true, error: "must be an ISO 8601 timestamp with a timezone, e.g. 2026-10-29T12:00:00Z" })
    .superRefine((value, ctx) => {
      const time = Date.parse(value);
      if (Number.isNaN(time)) {
        ctx.addIssue({ code: "custom", message: "is not a real date" });
      } else if (time > now.getTime() + L.maxFutureSkewMs) {
        ctx.addIssue({ code: "custom", message: "is in the future" });
      } else if (time < now.getTime() - L.maxAgeMs) {
        ctx.addIssue({ code: "custom", message: "is older than 30 days" });
      }
    });
}

export function eventSchema(now: Date) {
  return z.object({
    external_event_id: z
      .string()
      .min(1)
      .max(L.maxExternalIdLength)
      .regex(/^[A-Za-z0-9._:-]+$/, "may contain only letters, digits, and . _ : -"),
    event_type: z.string().min(1).max(L.maxEventTypeLength).refine(noNul, "must not contain NUL characters").default("error"),
    level: z.enum(EVENT_LEVELS).default("error"),
    message: z.string().min(1).max(L.maxMessageLength).refine(noNul, "must not contain NUL characters"),
    occurred_at: timestampSchema(now),
    endpoint: z.string().min(1).max(L.maxEndpointLength).refine(noNul, "must not contain NUL characters").optional(),
    stack_trace: z.string().max(L.maxStackLength).refine(noNul, "must not contain NUL characters").optional(),
    attributes: attributesSchema.optional(),
    /** Optional custom grouping key. */
    fingerprint: z.string().min(1).max(L.maxFingerprintLength).refine(noNul, "must not contain NUL characters").optional(),
    // Unknown keys (including any client-supplied project_id) are dropped, never trusted.
  });
}

export type IngestEvent = z.infer<ReturnType<typeof eventSchema>>;

export type ParseIssue = { path: string; message: string };

export type ParseResult =
  | { ok: true; events: IngestEvent[] }
  | { ok: false; reason: "too_many_events" | "invalid"; issues: ParseIssue[] };

function formatPath(path: PropertyKey[]): string {
  return path.reduce<string>(
    (acc, part) => (typeof part === "number" ? `${acc}[${part}]` : acc ? `${acc}.${String(part)}` : String(part)),
    "",
  );
}

/**
 * Accepts either a single event object or `{ "events": [...] }` (1 to maxBatchSize).
 * Validation is all-or-nothing: one bad event rejects the whole request so clients never
 * have to guess which events were stored.
 */
export function parseIngestBody(body: unknown, now: Date): ParseResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "invalid", issues: [{ path: "", message: "body must be a JSON object" }] };
  }

  const isBatch = "events" in body;
  let candidates: unknown[];
  let prefix = "";

  if (isBatch) {
    const events = (body as { events: unknown }).events;
    if (!Array.isArray(events) || events.length === 0) {
      return { ok: false, reason: "invalid", issues: [{ path: "events", message: "must be a non-empty array" }] };
    }
    if (events.length > L.maxBatchSize) {
      return {
        ok: false,
        reason: "too_many_events",
        issues: [{ path: "events", message: `a request may contain at most ${L.maxBatchSize} events` }],
      };
    }
    candidates = events;
    prefix = "events";
  } else {
    candidates = [body];
  }

  const schema = eventSchema(now);
  const parsed: IngestEvent[] = [];
  const issues: ParseIssue[] = [];

  candidates.forEach((candidate, index) => {
    const result = schema.safeParse(candidate);
    if (result.success) {
      parsed.push(result.data);
      return;
    }
    for (const issue of result.error.issues) {
      const base = prefix ? `${prefix}[${index}]` : "";
      const inner = formatPath(issue.path);
      issues.push({ path: [base, inner].filter(Boolean).join("."), message: issue.message });
    }
  });

  return issues.length > 0 ? { ok: false, reason: "invalid", issues: issues.slice(0, 20) } : { ok: true, events: parsed };
}
