/** Hard limits for the ingestion API. Documented in the README; change them in one place. */
export const INGEST_LIMITS = {
  /** Maximum request body, in bytes. */
  maxBodyBytes: 256 * 1024,
  /** Maximum events per request. */
  maxBatchSize: 50,
  maxExternalIdLength: 128,
  maxEventTypeLength: 100,
  maxMessageLength: 4_000,
  maxStackLength: 20_000,
  maxEndpointLength: 300,
  maxFingerprintLength: 200,
  /** Serialized size of the attributes object. */
  maxAttributesBytes: 16 * 1024,
  maxAttributesDepth: 5,
  maxAttributeKeys: 100,
  /** Events may not claim to be from the future beyond this clock-skew allowance. */
  maxFutureSkewMs: 5 * 60 * 1000,
  /** Events older than this are rejected (also guards against bad epoch/seconds conversions). */
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  /** Fixed-window limits (per minute). */
  rateLimitEventsPerKey: 600,
  rateLimitAuthFailuresPerIp: 30,
  rateLimitWindowSeconds: 60,
} as const;

export const EVENT_LEVELS = ["debug", "info", "warning", "error", "fatal"] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];
