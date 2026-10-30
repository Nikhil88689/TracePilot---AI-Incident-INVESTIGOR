import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AuthenticatedKey, IngestResultItem, IngestStore, PreparedEvent, RateLimitResult } from "./store";

/** Production store: three RPC calls to SQL functions only the service role can execute. */
export function createSupabaseIngestStore(): IngestStore {
  const admin = createAdminClient();

  return {
    async authenticate(keyHash): Promise<AuthenticatedKey | null> {
      const { data, error } = await admin.rpc("authenticate_ingest_key", { p_key_hash: keyHash });
      if (error) throw new Error(`authenticate_ingest_key failed: ${error.code ?? error.message}`);
      return data ? { keyId: data.key_id, projectId: data.project_id } : null;
    },

    async consumeRateLimit(bucket, cost, limit, windowSeconds): Promise<RateLimitResult> {
      const { data, error } = await admin.rpc("consume_rate_limit", {
        p_bucket: bucket,
        p_cost: cost,
        p_limit: limit,
        p_window_seconds: windowSeconds,
      });
      if (error) throw new Error(`consume_rate_limit failed: ${error.code ?? error.message}`);
      return { allowed: data.allowed, count: data.count, retryAfter: data.retry_after };
    },

    async ingest(projectId, events: PreparedEvent[]): Promise<IngestResultItem[]> {
      const { data, error } = await admin.rpc("ingest_events", { p_project_id: projectId, p_events: events });
      if (error) throw new Error(`ingest_events failed: ${error.code ?? error.message}`);
      return data.results as IngestResultItem[];
    },
  };
}
