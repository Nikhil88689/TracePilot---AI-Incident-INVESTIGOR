import type { SupabaseClient } from "@supabase/supabase-js";

type Row = {
  id: string;
  owner_id: string;
  name: string;
  environment: string;
  idempotency_key: string | null;
  created_at: string;
};

type DbError = { code: string; message: string } | null;

/**
 * Minimal in-memory stand-in for the slice of supabase-js the project service uses.
 * It enforces the same unique indexes as the migration so retry/duplicate paths are real.
 */
export function createFakeSupabase(options: { rows?: Row[]; failWith?: DbError } = {}) {
  const rows: Row[] = options.rows ? [...options.rows] : [];
  const state = { inserts: 0, failWith: options.failWith ?? null };

  const publicColumns = (r: Row) => ({
    id: r.id,
    name: r.name,
    environment: r.environment,
    created_at: r.created_at,
  });

  function from(table: string) {
    if (table !== "projects") throw new Error(`unexpected table ${table}`);

    return {
      select() {
        let filtered = rows;
        const chain = {
          eq(column: keyof Row, value: unknown) {
            filtered = filtered.filter((r) => r[column] === value);
            return chain;
          },
          order() {
            return Promise.resolve({ data: filtered.map(publicColumns), error: state.failWith });
          },
          maybeSingle() {
            return Promise.resolve({ data: filtered[0] ? publicColumns(filtered[0]) : null, error: state.failWith });
          },
        };
        return chain;
      },
      insert(values: Omit<Row, "id" | "created_at">) {
        return {
          select() {
            return {
              single(): Promise<{ data: ReturnType<typeof publicColumns> | null; error: DbError }> {
                if (state.failWith) return Promise.resolve({ data: null, error: state.failWith });
                if (rows.some((r) => r.owner_id === values.owner_id && r.name.toLowerCase() === values.name.toLowerCase())) {
                  return Promise.resolve({
                    data: null,
                    error: {
                      code: "23505",
                      message: 'duplicate key value violates unique constraint "projects_owner_name_uniq"',
                    },
                  });
                }
                if (
                  values.idempotency_key &&
                  rows.some((r) => r.owner_id === values.owner_id && r.idempotency_key === values.idempotency_key)
                ) {
                  return Promise.resolve({
                    data: null,
                    error: {
                      code: "23505",
                      message: 'duplicate key value violates unique constraint "projects_owner_idempotency_key_uniq"',
                    },
                  });
                }
                state.inserts += 1;
                const row: Row = { ...values, id: crypto.randomUUID(), created_at: new Date().toISOString() };
                rows.push(row);
                return Promise.resolve({ data: publicColumns(row), error: null });
              },
            };
          },
        };
      },
    };
  }

  return { client: { from } as unknown as SupabaseClient, rows, state };
}
