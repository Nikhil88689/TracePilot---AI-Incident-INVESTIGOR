import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "@/lib/incidents/queries";

const mocks = vi.hoisted(() => ({
  user: null as null | { email_confirmed_at: string | null },
  env: true as unknown,
  rpc: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => mocks.user }));
vi.mock("@/lib/env", () => ({ getPublicEnv: () => mocks.env }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/incidents/queries", async (orig) => ({ ...(await orig<typeof import("@/lib/incidents/queries")>()), asRpc: (c: unknown) => c as RpcClient }));

import { removeDemoAction, startDemoAction } from "./actions";
import { DEMO, DEMO_TOTAL_EVENTS } from "./scenario";
import { removeDemo, seedDemo } from "./service";

const PROJECT = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  mocks.user = { email_confirmed_at: "2026-01-01T00:00:00Z" };
  mocks.env = true;
  mocks.rpc.mockReset();
});

describe("seedDemo", () => {
  it("passes only the demo clock and reset flag, and parses the result", async () => {
    const rpc = vi.fn(async () => ({ data: { project_id: PROJECT, created: true }, error: null }));
    const now = new Date("2026-06-01T12:00:00Z");
    expect(await seedDemo({ rpc }, { now })).toEqual({ ok: true, projectId: PROJECT, created: true });
    expect(rpc).toHaveBeenCalledWith("seed_demo_project", { p_anchor: "2026-06-01T12:00:00.000Z", p_reset: false });
    await seedDemo({ rpc }, { now, reset: true });
    expect(rpc).toHaveBeenLastCalledWith("seed_demo_project", { p_anchor: "2026-06-01T12:00:00.000Z", p_reset: true });
  });

  it("maps a name clash and a missing session to typed reasons, other errors to DataError", async () => {
    const fail = (code: string) => ({ rpc: async () => ({ data: null, error: { code, message: "secret detail" } }) });
    expect(await seedDemo(fail("23505"))).toEqual({ ok: false, reason: "name_taken" });
    expect(await seedDemo(fail("28000"))).toEqual({ ok: false, reason: "not_signed_in" });
    const error = await seedDemo(fail("XX000")).catch((e) => e);
    expect(error.message).toBe("database call seed_demo_project failed (XX000)");
    expect(error.message).not.toContain("secret");
  });

  it("rejects an unexpected result shape", async () => {
    await expect(seedDemo({ rpc: async () => ({ data: { nope: 1 }, error: null }) })).rejects.toMatchObject({ code: "bad_shape" });
  });
});

describe("removeDemo", () => {
  it("returns whether a demo project existed", async () => {
    expect(await removeDemo({ rpc: async () => ({ data: true, error: null }) })).toBe(true);
    expect(await removeDemo({ rpc: async () => ({ data: false, error: null }) })).toBe(false);
  });
});

describe("startDemoAction / removeDemoAction", () => {
  it("requires a confirmed signed-in user and never calls the database otherwise", async () => {
    for (const user of [null, { email_confirmed_at: null }]) {
      mocks.user = user;
      expect(await startDemoAction({})).toMatchObject({ status: "error", message: expect.stringContaining("expired") });
      expect(await removeDemoAction()).toMatchObject({ status: "error" });
    }
    mocks.env = null;
    mocks.user = { email_confirmed_at: "x" };
    expect(await startDemoAction({})).toMatchObject({ status: "error" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("creates the demo for the signed-in user", async () => {
    mocks.rpc.mockResolvedValue({ data: { project_id: PROJECT, created: true }, error: null });
    expect(await startDemoAction({ reset: true })).toEqual({ status: "ok", projectId: PROJECT, created: true });
    expect(mocks.rpc).toHaveBeenCalledWith("seed_demo_project", expect.objectContaining({ p_reset: true }));
  });

  it("only honours reset when it is exactly true", async () => {
    mocks.rpc.mockResolvedValue({ data: { project_id: PROJECT, created: false }, error: null });
    await startDemoAction({ reset: "yes" as unknown as boolean });
    expect(mocks.rpc).toHaveBeenCalledWith("seed_demo_project", expect.objectContaining({ p_reset: false }));
  });

  it("explains a name clash and hides internal failures", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "23505", message: "dup" } });
    expect(await startDemoAction({})).toMatchObject({ status: "error", message: expect.stringContaining(DEMO.projectName) });
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "relation public.events does not exist" } });
    const r = await startDemoAction({});
    expect(r).toEqual({ status: "error", message: "Could not set up the demo. Please try again." });
  });

  it("removes the demo", async () => {
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    expect(await removeDemoAction()).toEqual({ status: "ok", removed: true });
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "x" } });
    expect(await removeDemoAction()).toMatchObject({ status: "error" });
  });
});

describe("scenario", () => {
  it("is internally consistent", () => {
    expect(DEMO.counts.http500 + DEMO.counts.dbTimeouts).toBe(DEMO.counts.incidentEvents);
    expect(DEMO_TOTAL_EVENTS).toBe(DEMO.counts.traffic + DEMO.counts.incidentEvents);
    const m = DEMO.minutesAgo;
    expect(m.deployBad).toBeGreaterThan(m.burstStart); // deploy first
    expect(m.burstStart).toBeGreaterThan(m.burstEnd);
    expect(m.burstEnd).toBeGreaterThan(m.rollback); // errors stop before the rollback
    expect(m.rollback).toBeGreaterThan(m.analysis);
  });
});
