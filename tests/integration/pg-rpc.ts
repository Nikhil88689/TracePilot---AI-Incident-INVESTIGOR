import type pg from "pg";
import type { RpcClient } from "../../src/lib/incidents/queries";

/**
 * Emulates `supabase.rpc()` against a real Postgres as a given user: each call runs in its own
 * transaction with role `authenticated` and the user's id as the JWT subject (so RLS and
 * auth.uid() behave as they do under PostgREST). `userId = null` runs as `anon`.
 * Results are shaped like PostgREST's: table functions -> JSON array, scalar functions -> value;
 * bigint -> number, timestamptz -> ISO string (via to_jsonb).
 */
export function createPgRpc(pool: pg.Pool, userId: string | null): RpcClient {
  return {
    async rpc(fn, args = {}) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(userId ? "set local role authenticated" : "set local role anon");
        if (userId) await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);

        const names = Object.keys(args);
        const call = `public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")})`;
        // Look up the shape as the superuser would see it; role switch does not affect pg_proc reads.
        const meta = await client.query(
          "select p.proretset from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1 limit 1",
          [fn],
        );
        const sql = meta.rows[0]?.proretset
          ? `select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) as data from (select * from ${call}) t`
          : `select ${call} as data`;
        // PostgREST sends JSON, so jsonb arguments arrive as JSON. node-pg would otherwise turn a JS
        // array into a Postgres array literal, so serialize the ones the function declares as jsonb.
        const sig = await client.query("select pg_get_function_arguments(p.oid) as a from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1 limit 1", [fn]);
        const types = Object.fromEntries(
          String(sig.rows[0]?.a ?? "")
            .split(/,\s+(?=p_)/)
            .map((part) => part.trim().split(/\s+/))
            .map(([name, type]) => [name, type]),
        );
        const params = names.map((n) => (types[n] === "jsonb" && args[n] !== null && typeof args[n] === "object" ? JSON.stringify(args[n]) : args[n]));
        const { rows } = await client.query(sql, params);
        await client.query("commit");
        return { data: rows[0].data, error: null };
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        const e = error as { code?: string; message: string };
        return { data: null, error: { code: e.code, message: e.message } };
      } finally {
        client.release();
      }
    },
  };
}
