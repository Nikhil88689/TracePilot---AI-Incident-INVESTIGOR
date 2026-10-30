import { describe, expect, it } from "vitest";
import { createFakeSupabase } from "../../../tests/helpers/fake-supabase";
import { createProject, listProjects } from "./service";

const OWNER = "11111111-1111-4111-8111-111111111111";
const REQ = "22222222-2222-4222-8222-222222222222";
const input = { name: "checkout-web", environment: "production" as const, requestId: REQ };

describe("createProject", () => {
  it("creates a project for the owner", async () => {
    const db = createFakeSupabase();
    const result = await createProject(db.client, OWNER, input);
    expect(result).toMatchObject({ ok: true, created: true, project: { name: "checkout-web", environment: "production" } });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].owner_id).toBe(OWNER);
  });

  it("is idempotent: retrying the same request returns the original and inserts nothing", async () => {
    const db = createFakeSupabase();
    const first = await createProject(db.client, OWNER, input);
    const retry = await createProject(db.client, OWNER, input);
    expect(retry).toMatchObject({ ok: true, created: false });
    expect(retry.ok && first.ok && retry.project.id).toBe(first.ok && first.project.id);
    expect(db.state.inserts).toBe(1);
  });

  it("rejects a duplicate name (case-insensitive) with a friendly error", async () => {
    const db = createFakeSupabase();
    await createProject(db.client, OWNER, input);
    const result = await createProject(db.client, OWNER, {
      ...input,
      name: "Checkout-Web",
      requestId: "33333333-3333-4333-8333-333333333333",
    });
    expect(result).toMatchObject({ ok: false, reason: "duplicate_name" });
    expect(db.rows).toHaveLength(1);
  });

  it("recovers when a concurrent retry wins the race on the idempotency key", async () => {
    const db = createFakeSupabase();
    // First lookup finds nothing, but the row appears before our insert runs.
    const realFrom = db.client.from.bind(db.client);
    let lookups = 0;
    db.client.from = ((table: string) => {
      const builder = realFrom(table) as ReturnType<typeof realFrom> & { select: () => unknown };
      const originalSelect = builder.select.bind(builder);
      builder.select = ((...args: unknown[]) => {
        const chain = (originalSelect as (...a: unknown[]) => { maybeSingle: () => Promise<unknown> })(...args);
        if (args.length === 1 && lookups++ === 0 && chain.maybeSingle) {
          chain.maybeSingle = () => {
            db.rows.push({
              id: "winner",
              owner_id: OWNER,
              name: "other-name",
              environment: "production",
              idempotency_key: REQ,
              created_at: new Date().toISOString(),
            });
            return Promise.resolve({ data: null, error: null });
          };
        }
        return chain;
      }) as typeof builder.select;
      return builder;
    }) as typeof db.client.from;

    const result = await createProject(db.client, OWNER, input);
    expect(result).toMatchObject({ ok: true, created: false, project: { id: "winner" } });
  });

  it("returns a generic failure on unexpected database errors without leaking details", async () => {
    const db = createFakeSupabase({ failWith: { code: "XX000", message: "secret internal detail" } });
    const result = await createProject(db.client, OWNER, input);
    expect(result).toMatchObject({ ok: false, reason: "failed" });
    expect(JSON.stringify(result)).not.toContain("secret internal detail");
  });
});

describe("listProjects", () => {
  it("returns rows", async () => {
    const db = createFakeSupabase();
    await createProject(db.client, OWNER, input);
    const result = await listProjects(db.client);
    expect(result.ok && result.projects).toHaveLength(1);
  });

  it("reports a missing schema distinctly", async () => {
    const db = createFakeSupabase({ failWith: { code: "PGRST205", message: "no table" } });
    expect(await listProjects(db.client)).toMatchObject({ ok: false, reason: "schema_missing" });
  });
});
