import type { EventLevel } from "./constants";
import type { IncidentSeverity } from "./fingerprint";

/** An event after validation, ready for the database function. Never contains a project id. */
export type PreparedEvent = {
  external_event_id: string;
  event_type: string;
  level: EventLevel;
  message: string;
  stack_trace: string | null;
  fingerprint: string;
  title: string;
  severity: IncidentSeverity;
  endpoint: string | null;
  occurred_at: string;
  attributes: Record<string, unknown>;
};

export type IngestResultItem = {
  external_event_id: string;
  status: "accepted" | "duplicate";
  incident_id: string;
  occurrence_count: number;
};

export type AuthenticatedKey = { keyId: string; projectId: string };

export type RateLimitResult = { allowed: boolean; count: number; retryAfter: number };

/**
 * Everything the ingestion handler needs from the database. Each method maps 1:1 to a SQL
 * function (authenticate_ingest_key, consume_rate_limit, ingest_events), so production
 * (Supabase RPC) and the integration tests (a real Postgres) run the same logic.
 */
export interface IngestStore {
  /** Resolves a key hash to its project. Returns null for unknown or revoked keys. */
  authenticate(keyHash: string): Promise<AuthenticatedKey | null>;
  consumeRateLimit(bucket: string, cost: number, limit: number, windowSeconds: number): Promise<RateLimitResult>;
  /** Atomic: every event in the batch is stored and linked, or none is. */
  ingest(projectId: string, events: PreparedEvent[]): Promise<IngestResultItem[]>;
}
