import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "../../../tests/helpers/fake-supabase";

const state = vi.hoisted(() => ({
  user: null as { id: string; email_confirmed_at: string | null } | null,
  db: null as unknown,
}));

vi.mock("@/lib/env", () => ({ getPublicEnv: () => ({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" }) }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => state.user }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => (state.db as { client: unknown }).client }));

import { createProjectForCurrentUser } from "./create";

const REQ = "22222222-2222-4222-8222-222222222222";
const valid = { name: "  checkout-web  ", environment: "staging", requestId: REQ };

describe("createProjectForCurrentUser", () => {
  beforeEach(() => {
    state.user = { id: "11111111-1111-4111-8111-111111111111", email_confirmed_at: "2026-10-29T00:00:00Z" };
    state.db = createFakeSupabase();
  });

  it("rejects unauthenticated callers with 401 and creates nothing", async () => {
    state.user = null;
    const { http, state: result } = await createProjectForCurrentUser(valid);
    expect(http).toBe(401);
    expect(result.status).toBe("error");
    expect((state.db as ReturnType<typeof createFakeSupabase>).rows).toHaveLength(0);
  });

  it("rejects users whose email is not verified", async () => {
    state.user = { id: "u", email_confirmed_at: null };
    expect((await createProjectForCurrentUser(valid)).http).toBe(401);
  });

  it.each([
    ["empty name", { ...valid, name: "   " }, "name"],
    ["name too long", { ...valid, name: "x".repeat(81) }, "name"],
    ["unknown environment", { ...valid, environment: "prod" }, "environment"],
  ])("returns 400 with a field error for %s", async (_label, body, field) => {
    const { http, state: result } = await createProjectForCurrentUser(body);
    expect(http).toBe(400);
    expect(result.status === "error" && result.fieldErrors?.[field as "name"]).toBeTruthy();
  });

  it("rejects a malformed request id and non-object bodies", async () => {
    expect((await createProjectForCurrentUser({ ...valid, requestId: "not-a-uuid" })).http).toBe(400);
    expect((await createProjectForCurrentUser(null)).http).toBe(400);
    expect((await createProjectForCurrentUser("nope")).http).toBe(400);
  });

  it("creates with 201, trimming the name, and owns the row by the session user", async () => {
    const { http, state: result } = await createProjectForCurrentUser(valid);
    expect(http).toBe(201);
    expect(result.status === "success" && result.project.name).toBe("checkout-web");
    expect((state.db as ReturnType<typeof createFakeSupabase>).rows[0].owner_id).toBe(state.user!.id);
  });

  it("ignores a client-supplied owner id", async () => {
    await createProjectForCurrentUser({ ...valid, owner_id: "99999999-9999-4999-8999-999999999999" });
    expect((state.db as ReturnType<typeof createFakeSupabase>).rows[0].owner_id).toBe(state.user!.id);
  });

  it("returns 200 and no second row when the request is retried", async () => {
    await createProjectForCurrentUser(valid);
    const retry = await createProjectForCurrentUser(valid);
    expect(retry.http).toBe(200);
    expect((state.db as ReturnType<typeof createFakeSupabase>).rows).toHaveLength(1);
  });

  it("returns 409 for a duplicate name under a new request id", async () => {
    await createProjectForCurrentUser(valid);
    const dup = await createProjectForCurrentUser({ ...valid, requestId: "44444444-4444-4444-8444-444444444444" });
    expect(dup.http).toBe(409);
  });
});
