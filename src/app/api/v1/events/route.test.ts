import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  env: null as null | object,
  handler: vi.fn(async () => Response.json({ ok: true }, { status: 201 })),
  createStore: vi.fn(() => ({ marker: "store" })),
}));

vi.mock("@/lib/env", () => ({ getPublicEnv: () => state.env }));
vi.mock("@/lib/ingest/handler", () => ({ handleIngest: state.handler }));
vi.mock("@/lib/ingest/supabase-store", () => ({ createSupabaseIngestStore: state.createStore }));

import { POST } from "./route";

const req = () => new Request("http://localhost/api/v1/events", { method: "POST", body: "{}" });

describe("POST /api/v1/events", () => {
  beforeEach(() => {
    state.handler.mockClear();
    state.createStore.mockClear();
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    state.env = null;
  });

  it("returns 503 without touching the database when Supabase is not configured", async () => {
    const res = await POST(req());
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("ingestion_unavailable");
    expect(state.createStore).not.toHaveBeenCalled();
  });

  it("returns 503 when the server-only service role key is missing", async () => {
    state.env = { NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co" };
    expect((await POST(req())).status).toBe(503);
    expect(state.handler).not.toHaveBeenCalled();
  });

  it("delegates to the ingestion handler once configured", async () => {
    state.env = { NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co" };
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    const res = await POST(req());
    expect(res.status).toBe(201);
    expect(state.handler).toHaveBeenCalledTimes(1);
    expect((state.handler.mock.calls[0] as unknown[])[1]).toMatchObject({ store: { marker: "store" } });
  });
});
