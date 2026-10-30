import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "../../../../tests/helpers/fake-supabase";

const state = vi.hoisted(() => ({
  user: null as { id: string; email_confirmed_at: string | null } | null,
  db: null as unknown,
}));

vi.mock("@/lib/env", () => ({ getPublicEnv: () => ({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" }) }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => state.user }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => (state.db as { client: unknown }).client }));

import { GET, POST } from "./route";

const REQ = "22222222-2222-4222-8222-222222222222";
const post = (body: unknown, raw = false) =>
  POST(
    new Request("http://localhost/api/projects", {
      method: "POST",
      body: raw ? (body as string) : JSON.stringify(body),
    }),
  );

describe("/api/projects", () => {
  beforeEach(() => {
    state.user = null;
    state.db = createFakeSupabase();
  });

  it("GET returns 401 when signed out", async () => {
    expect((await GET()).status).toBe(401);
  });

  it("POST returns 401 when signed out and does not write", async () => {
    const res = await post({ name: "x", environment: "production", requestId: REQ });
    expect(res.status).toBe(401);
    expect((state.db as ReturnType<typeof createFakeSupabase>).rows).toHaveLength(0);
  });

  it("does not accept a project ingestion key as credentials for dashboard APIs", async () => {
    // With no session, a valid-looking ingestion key must not authenticate anything here.
    const key = "tp_live_" + "A".repeat(43);
    const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
    const post = await POST(
      new Request("http://localhost/api/projects", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "x", environment: "production", requestId: REQ }),
      }),
    );
    expect(post.status).toBe(401);
    expect((state.db as ReturnType<typeof createFakeSupabase>).rows).toHaveLength(0);
    expect((await GET()).status).toBe(401);
  });

  it("POST rejects invalid JSON and invalid input", async () => {
    state.user = { id: "u1", email_confirmed_at: "2026-10-29T00:00:00Z" };
    expect((await post("{not json", true)).status).toBe(400);
    const res = await post({ name: "", environment: "production", requestId: REQ });
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors.name).toBeTruthy();
  });

  it("creates (201), is idempotent on retry (200), and lists only that user's projects", async () => {
    state.user = { id: "u1", email_confirmed_at: "2026-10-29T00:00:00Z" };
    const body = { name: "api", environment: "development", requestId: REQ };
    expect((await post(body)).status).toBe(201);
    expect((await post(body)).status).toBe(200);

    const list = await (await GET()).json();
    expect(list.projects).toHaveLength(1);
    expect(list.projects[0]).not.toHaveProperty("owner_id");
  });
});

describe("/api/projects CSRF guard", () => {
  it("refuses cross-site POSTs before touching auth or the database", async () => {
    state.user = { id: "u", email_confirmed_at: "x" };
    state.db = createFakeSupabase();
    for (const headers of [{ origin: "https://evil.example", host: "localhost" }, { "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
      const res = await POST(new Request("http://localhost/api/projects", { method: "POST", headers, body: JSON.stringify({ name: "x", environment: "production", requestId: REQ }) }));
      expect(res.status).toBe(403);
    }
    expect((state.db as ReturnType<typeof createFakeSupabase>).rows).toHaveLength(0);
  });
});
