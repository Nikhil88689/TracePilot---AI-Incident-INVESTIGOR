import type pg from "pg";
import type { IngestStore } from "../../src/lib/ingest/store";

/** IngestStore backed by a real Postgres, calling the exact SQL functions production calls via RPC. */
export function createPgIngestStore(pool: pg.Pool): IngestStore {
  return {
    async authenticate(keyHash) {
      const { rows } = await pool.query("select public.authenticate_ingest_key($1) as r", [keyHash]);
      const r = rows[0].r;
      return r ? { keyId: r.key_id, projectId: r.project_id } : null;
    },
    async consumeRateLimit(bucket, cost, limit, windowSeconds) {
      const { rows } = await pool.query("select public.consume_rate_limit($1, $2, $3, $4) as r", [
        bucket,
        cost,
        limit,
        windowSeconds,
      ]);
      const r = rows[0].r;
      return { allowed: r.allowed, count: r.count, retryAfter: r.retry_after };
    },
    async ingest(projectId, events) {
      const { rows } = await pool.query("select public.ingest_events($1, $2::jsonb) as r", [
        projectId,
        JSON.stringify(events),
      ]);
      return rows[0].r.results;
    },
  };
}
