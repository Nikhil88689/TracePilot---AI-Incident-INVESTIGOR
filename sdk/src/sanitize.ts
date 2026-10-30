/**
 * The server validates a batch all-or-nothing, so one malformed event would reject its
 * neighbours too. Everything below exists to make sure the SDK only ever sends events that
 * satisfy the API limits, whatever the host application throws at it.
 */
export const LIMITS = {
  message: 4_000,
  stack: 20_000,
  endpoint: 300,
  eventType: 100,
  eventId: 128,
  attributesBytes: 15 * 1024, // server limit is 16 KiB; keep a margin
  attributesDepth: 5,
  attributeKeys: 100,
} as const;

const NUL = /\u0000/g;
const EVENT_ID = /^[A-Za-z0-9._:-]+$/;

export function clean(value: string, max: number): string {
  return value.replace(NUL, "").slice(0, max);
}

export function isValidEventId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= LIMITS.eventId && EVENT_ID.test(id);
}

/**
 * Produces JSON-safe attributes within the server limits: circular references, bigint,
 * functions, NUL characters, excessive depth/keys/size are all handled without throwing.
 * Returns undefined when nothing usable remains.
 */
export function sanitizeAttributes(attributes: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!attributes || typeof attributes !== "object") return undefined;

  const seen = new WeakSet<object>();
  const walk = (value: unknown, depth: number): unknown => {
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") return clean(value, 2_000);
    if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return undefined;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (value instanceof Error) return { name: clean(value.name, 100), message: clean(value.message, 500) };
    if (typeof value !== "object") return undefined;

    if (seen.has(value)) return "[Circular]";
    // The attributes object itself is depth 1 on the server, so leave room for it.
    if (depth >= LIMITS.attributesDepth - 1) return "[Truncated]";
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.slice(0, 50).map((v) => walk(v, depth + 1) ?? null);
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value).slice(0, LIMITS.attributeKeys)) {
        const walked = walk(child, depth + 1);
        if (walked !== undefined) out[clean(key, 100)] = walked;
      }
      return out;
    } finally {
      seen.delete(value);
    }
  };

  try {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(attributes).slice(0, LIMITS.attributeKeys)) {
      const walked = walk(child, 1);
      if (walked !== undefined) result[clean(key, 100)] = walked;
    }
    if (Object.keys(result).length === 0) return undefined;
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > LIMITS.attributesBytes) {
      return { attributes_dropped: "exceeded the 16 KiB attribute limit" };
    }
    return result;
  } catch {
    return undefined; // e.g. a throwing getter: never let attributes break error reporting
  }
}
