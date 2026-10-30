import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  env: {} as object | null,
  user: null as null | { id: string; email_confirmed_at: string | null },
  rpc: vi.fn(),
  aiConfig: null as null | object,
}));

vi.mock("@/lib/env", () => ({ getPublicEnv: () => state.env }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => state.user }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: state.rpc }) }));
vi.mock("@/lib/ai/config", () => ({ getAiConfig: () => state.aiConfig }));

import { changeStatusAction, loadEventDetailAction, toggleStepAction } from "./actions";

const ID = "11111111-1111-4111-8111-111111111111";
const SIGNED_IN = { id: "u1", email_confirmed_at: "2026-10-30T00:00:00Z" };

describe("server actions: authentication boundary", () => {
  beforeEach(() => {
    state.env = {};
    state.user = null;
    state.aiConfig = null;
    state.rpc.mockReset();
  });

  it("refuses every action when signed out, without touching the database", async () => {
    expect(await changeStatusAction({ incidentId: ID, to: "resolved", expected: "open" })).toMatchObject({ status: "error", message: expect.stringContaining("session has expired") });
    expect(await loadEventDetailAction({ eventId: ID })).toMatchObject({ status: "error" });
    expect(await toggleStepAction({ analysisId: ID, index: 0, done: true })).toMatchObject({ status: "error" });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses users whose email is not verified", async () => {
    state.user = { id: "u1", email_confirmed_at: null };
    expect((await changeStatusAction({ incidentId: ID, to: "resolved", expected: "open" })).status).toBe("error");
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses when Supabase is not configured", async () => {
    state.env = null;
    state.user = SIGNED_IN;
    expect((await changeStatusAction({ incidentId: ID, to: "resolved", expected: "open" })).status).toBe("error");
  });
});

describe("changeStatusAction", () => {
  beforeEach(() => {
    state.env = {};
    state.user = SIGNED_IN;
    state.rpc.mockReset();
  });

  it("maps a successful change", async () => {
    state.rpc.mockResolvedValue({ data: { result: "ok", status: "resolved", resolved_at: "2026-10-30T12:00:00Z" }, error: null });
    expect(await changeStatusAction({ incidentId: ID, to: "resolved", expected: "open" })).toEqual({ status: "ok", newStatus: "resolved", resolvedAt: "2026-10-30T12:00:00Z" });
    expect(state.rpc).toHaveBeenCalledWith("change_incident_status", { p_id: ID, p_to: "resolved", p_expected: "open" });
  });

  it("reports a conflict with the current status", async () => {
    state.rpc.mockResolvedValue({ data: { result: "conflict", status: "resolved" }, error: null });
    expect(await changeStatusAction({ incidentId: ID, to: "investigating", expected: "open" })).toEqual({ status: "conflict", current: "resolved" });
  });

  it("treats another user's incident like a missing one", async () => {
    state.rpc.mockResolvedValue({ data: { result: "not_found" }, error: null });
    const r = await changeStatusAction({ incidentId: ID, to: "resolved", expected: "open" });
    expect(r).toMatchObject({ status: "error", message: expect.stringContaining("no longer exists or you don't have access") });
  });

  it.each([
    [{ incidentId: "nope", to: "resolved", expected: "open" }],
    [{ incidentId: ID, to: "closed", expected: "open" }],
    [{ incidentId: ID, to: "resolved", expected: "x" }],
  ])("rejects invalid input %j before any database call", async (input) => {
    expect((await changeStatusAction(input)).status).toBe("error");
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("rejects an invalid transition before any database call", async () => {
    const r = await changeStatusAction({ incidentId: ID, to: "investigating", expected: "resolved" });
    expect(r).toMatchObject({ status: "error", message: expect.stringContaining("isn't allowed") });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("returns a generic message when the database fails, without internals", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "relation secret missing" } });
    const r = await changeStatusAction({ incidentId: ID, to: "resolved", expected: "open" });
    expect(JSON.stringify(r)).not.toContain("secret");
    expect(r.status).toBe("error");
  });
});

describe("loadEventDetailAction / investigateAction", () => {
  beforeEach(() => {
    state.env = {};
    state.user = SIGNED_IN;
    state.rpc.mockReset();
  });

  it("returns 'not found' for malformed or invisible events", async () => {
    expect(await loadEventDetailAction({ eventId: "x" })).toEqual({ status: "error", message: "Event not found." });
    state.rpc.mockResolvedValue({ data: [], error: null });
    expect(await loadEventDetailAction({ eventId: ID })).toEqual({ status: "error", message: "Event not found." });
  });

  it("returns the event when visible", async () => {
    state.rpc.mockResolvedValue({
      data: [{ id: ID, project_id: ID, project_name: "p", external_event_id: "e", event_type: "T", level: "error", message: "m", endpoint: null, occurred_at: "2026-10-30T00:00:00Z", incident_id: null, incident_title: null, stack_trace: "s", attributes: { a: 1 } }],
      error: null,
    });
    expect(await loadEventDetailAction({ eventId: ID })).toMatchObject({ status: "ok", event: { id: ID, stackTrace: "s", attributes: { a: 1 } } });
  });

});

describe("toggleStepAction", () => {
  beforeEach(() => {
    state.env = {};
    state.user = SIGNED_IN;
    state.rpc.mockReset();
  });

  it("persists a tick and returns the saved list", async () => {
    state.rpc.mockResolvedValue({ data: { result: "ok", completed_steps: [0, 2] }, error: null });
    expect(await toggleStepAction({ analysisId: ID, index: 2, done: true })).toEqual({ status: "ok", completedSteps: [0, 2] });
    expect(state.rpc).toHaveBeenCalledWith("set_analysis_step", { p_analysis: ID, p_index: 2, p_done: true });
  });

  it.each([
    [{ analysisId: "nope", index: 0, done: true }],
    [{ analysisId: ID, index: -1, done: true }],
    [{ analysisId: ID, index: 1.5, done: true }],
    [{ analysisId: ID, index: 0, done: "yes" as never }],
  ])("rejects invalid input %j before any database call", async (input) => {
    expect((await toggleStepAction(input)).status).toBe("error");
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("treats someone else's (or a missing) analysis as not found", async () => {
    state.rpc.mockResolvedValue({ data: { result: "not_found" }, error: null });
    expect(await toggleStepAction({ analysisId: ID, index: 0, done: true })).toMatchObject({ status: "error", message: expect.stringContaining("no longer exists") });
  });

  it("reports an out-of-range step as an invalid request, and database failures generically", async () => {
    state.rpc.mockResolvedValueOnce({ data: { result: "invalid_index" }, error: null });
    expect(await toggleStepAction({ analysisId: ID, index: 9, done: true })).toMatchObject({ status: "error", message: "Invalid request." });
    state.rpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "pg detail" } });
    const r = await toggleStepAction({ analysisId: ID, index: 0, done: true });
    expect(JSON.stringify(r)).not.toContain("pg detail");
  });
});
