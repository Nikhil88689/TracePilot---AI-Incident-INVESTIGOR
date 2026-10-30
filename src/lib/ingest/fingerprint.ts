import { createHash } from "node:crypto";
import type { EventLevel } from "./constants";

const FRAMES_USED = 3;

/**
 * Strips the volatile parts of a message (ids, numbers, quoted values) so that
 * "Order 4812 not found" and "Order 9930 not found" fingerprint identically.
 */
export function normalizeMessage(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/(["'`])(?:(?!\1).)*\1/g, "<str>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\d+(?:\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function normalizeFile(file: string): string {
  const cleaned = file
    .replace(/^file:\/\/\/?/, "")
    .replace(/[?#].*$/, "")
    .replace(/\\/g, "/")
    // Bundler content hashes (app.3f9a1b2c.js, chunk-ABC123DEF.js) change on every deploy.
    .replace(/[.-][0-9a-zA-Z]{8,}(?=\.[a-z]+$)/, "");
  return cleaned.split("/").slice(-2).join("/");
}

/**
 * Extracts up to three application frames from a V8-style stack ("at fn (file:line:col)").
 * Line and column numbers are dropped so unrelated edits to a file do not split an incident.
 * Library and runtime frames are skipped. Other stack formats yield no frames, and the
 * fingerprint falls back to message + endpoint.
 */
export function stackFrames(stack: string | undefined): string[] {
  if (!stack) return [];
  const frames: string[] = [];
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("at ")) continue;
    const match = /^at\s+(?:(.+?)\s+\()?(.+?):\d+:\d+\)?$/.exec(line);
    if (!match) continue;
    const [, fn = "<anonymous>", file] = match;
    if (/node_modules|^node:|^internal\//.test(file)) continue;
    frames.push(`${fn}@${normalizeFile(file)}`);
    if (frames.length === FRAMES_USED) break;
  }
  return frames;
}

/** `/orders/4812/items/9` -> `/orders/:id/items/:id`; query string removed. */
export function normalizeEndpoint(endpoint: string | undefined): string {
  if (!endpoint) return "";
  return endpoint
    .replace(/[?#].*$/, "")
    .replace(/\/(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\/|$)/gi, "/:id");
}

export type FingerprintInput = {
  event_type: string;
  message: string;
  stack_trace?: string;
  endpoint?: string;
  /** Caller-supplied grouping key; overrides automatic grouping. */
  fingerprint?: string;
};

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);

/** Deterministic 32-hex-char grouping key. Same inputs always produce the same output. */
export function computeFingerprint(input: FingerprintInput): string {
  if (input.fingerprint) return sha(`custom:${input.fingerprint}`);

  const frames = stackFrames(input.stack_trace);
  const parts = [input.event_type, normalizeMessage(input.message), ...frames];
  // Without a usable stack, the endpoint keeps unrelated errors with generic messages apart.
  if (frames.length === 0) parts.push(normalizeEndpoint(input.endpoint));
  return sha(parts.join("\n"));
}

export function incidentTitle(input: Pick<FingerprintInput, "event_type" | "message">): string {
  const firstLine = (input.message.split("\n")[0] ?? "").trim();
  const title = input.event_type !== "error" && !firstLine.startsWith(input.event_type)
    ? `${input.event_type}: ${firstLine}`
    : firstLine;
  return title.slice(0, 200) || "Untitled error";
}

export type IncidentSeverity = "low" | "medium" | "high" | "critical";

export function severityForLevel(level: EventLevel): IncidentSeverity {
  switch (level) {
    case "fatal":
      return "critical";
    case "error":
      return "high";
    case "warning":
      return "medium";
    default:
      return "low";
  }
}
