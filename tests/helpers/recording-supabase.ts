import type { SupabaseClient } from "@supabase/supabase-js";

type Result = { data?: unknown; error?: { code?: string; message: string } | null; count?: number | null };
type Call = { table: string; method: string; args: unknown[] };

/**
 * A scripted Supabase stand-in. `script` maps "table.operation" (e.g. "api_keys.insert") to the
 * result the awaited chain should resolve to; every chained call is recorded for assertions.
 */
export function recordingSupabase(script: Record<string, Result | Result[]>) {
  const calls: Call[] = [];
  const counters: Record<string, number> = {};

  function chain(table: string, operation: string) {
    const key = `${table}.${operation}`;
    const proxy: unknown = new Proxy(() => undefined, {
      get(_t, prop: string) {
        if (prop === "then") {
          const entry = script[key];
          const index = (counters[key] = (counters[key] ?? -1) + 1);
          const result = (Array.isArray(entry) ? entry[Math.min(index, entry.length - 1)] : entry) ?? { data: null, error: null };
          return (resolve: (v: Result) => void) => resolve({ error: null, ...result });
        }
        return (...args: unknown[]) => {
          calls.push({ table, method: `${operation}.${prop}`, args });
          return proxy;
        };
      },
    });
    return proxy;
  }

  const client = {
    from(table: string) {
      return new Proxy(
        {},
        {
          get(_t, operation: string) {
            return (...args: unknown[]) => {
              calls.push({ table, method: operation, args });
              return chain(table, operation);
            };
          },
        },
      );
    },
  } as unknown as SupabaseClient;

  return { client, calls, find: (table: string, method: string) => calls.filter((c) => c.table === table && c.method === method) };
}
