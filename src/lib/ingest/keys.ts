import { createHash, randomBytes } from "node:crypto";

export const API_KEY_PREFIX = "tp_live_";
/** 32 random bytes -> 43 base64url characters. */
const KEY_PATTERN = /^tp_live_[A-Za-z0-9_-]{43}$/;

export type GeneratedApiKey = {
  /** Plaintext. Show it to the user once; never store or log it. */
  key: string;
  /** Short, non-secret identifier for UI display (e.g. "tp_live_Ab3x"). */
  prefix: string;
  /** SHA-256 hex digest: the only thing persisted. */
  hash: string;
};

/**
 * Keys carry 256 bits from a CSPRNG, so a fast hash is appropriate (there is nothing to
 * brute-force; slow password hashes would only add latency to every ingest request).
 */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function generateApiKey(): GeneratedApiKey {
  const key = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { key, prefix: key.slice(0, API_KEY_PREFIX.length + 4), hash: hashApiKey(key) };
}

/** Extracts a well-formed key from an Authorization header, or null. Rejects junk before any DB work. */
export function extractBearerKey(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const token = match?.[1];
  return token && KEY_PATTERN.test(token) ? token : null;
}
