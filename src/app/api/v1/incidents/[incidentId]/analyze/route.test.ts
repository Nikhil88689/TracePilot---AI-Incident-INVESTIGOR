import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  env: null as null | object,
  handler: vi.fn(async () => Response.json({ ok: true }, { status: 200 })),
}));

vi.mock("@/lib/env", () => ({ getPublicEnv: () => state.env }));
vi.mock("@/lib/ai/analyze-handler", () => ({ handleAnalyze: state.handler }));
vi.mock("@/lib/ai/config", () => ({ getAiConfig: () => null }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => null }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

import { POST } from "./route";

const call = (id = "x") => POST(new Request("http://localhost/api/v1/incidents/x/analyze", { method: "POST" }), { params: Promise.resolve({ incidentId: id }) });

describe("analyze route wiring", () => {
  beforeEach(() => state.handler.mockClear());

  it("returns 503 when Supabase is not configured, without calling the handler", async () => {
    state.env = null;
    expect((await call()).status).toBe(503);
    expect(state.handler).not.toHaveBeenCalled();
  });

  it("passes the incident id and session-based dependencies to the handler", async () => {
    state.env = {};
    await call("abc");
    const [, id, deps] = state.handler.mock.calls[0] as unknown as [Request, string, Record<string, unknown>];
    expect(id).toBe("abc");
    expect(Object.keys(deps).sort()).toEqual(["getConfig", "getDb", "getUser"]);
  });
});
