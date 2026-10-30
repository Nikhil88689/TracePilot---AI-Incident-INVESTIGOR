// @vitest-environment jsdom
/**
 * The real server pages (incidents, incident detail, events, dashboard) rendered against the real
 * data layer on a real Postgres, as real users with RLS active. Only the framework edges are
 * stubbed (router, cookies-based client creation, server actions).
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { adminPool, buildEvent, createUserAndProject, ingestEvents, servicePool } from "./pg-harness";
import { createPgRpc } from "./pg-rpc";

const world = vi.hoisted(() => ({ userId: null as string | null, pool: null as unknown, ai: null as null | object }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/incidents",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/incidents/actions", () => ({ changeStatusAction: vi.fn(), investigateAction: vi.fn(), loadEventDetailAction: vi.fn() }));
vi.mock("@/lib/ingest/test-event-action", () => ({ sendTestEventAction: vi.fn() }));
vi.mock("@/lib/ai/config", () => ({ getAiConfig: () => world.ai }));
// The page asks for "a database client as the current user": give it the real-Postgres RPC adapter.
vi.mock("@/lib/supabase/server", async () => {
  const { createPgRpc } = await import("./pg-rpc");
  return { createClient: async () => createPgRpc(world.pool as pg.Pool, world.userId) };
});
vi.mock("@/lib/incidents/scope", () => ({
  WORKSPACE_LABEL: "Your projects",
  resolveProjectScope: async (_db: unknown, requested: string | null) => {
    const rows = (await (world.pool as pg.Pool).query("select id, name, environment from public.projects where owner_id = $1", [world.userId])).rows;
    const projects = rows.map((r) => ({ id: r.id, name: r.name, workspace: "Your projects", environment: r.environment }));
    return { projects, project: projects.find((p) => p.id === requested) ?? null };
  },
}));

import DashboardPage from "../../src/app/(app)/dashboard/page";
import EventsPage from "../../src/app/(app)/events/page";
import IncidentPage from "../../src/app/(app)/incidents/[incidentId]/page";
import IncidentsPage from "../../src/app/(app)/incidents/page";
import { AppShell } from "../../src/components/layout/app-shell";

const port = Number(process.env.TP_TEST_PG_PORT);
let admin: pg.Pool;
let service: pg.Pool;

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

type Seed = { userId: string; projectId: string; ids: { cart: string; slow: string; auth: string }; other: { userId: string; incidentId: string } };
let seed: Seed;

beforeAll(async () => {
  admin = adminPool(port);
  service = servicePool(port, 6);
  world.pool = admin;

  const a = await createUserAndProject(admin, "shop");
  const b = await createUserAndProject(admin, "other");
  const cart = await ingestEvents(service, a.projectId, [
    buildEvent({ message: "Cart crash: items undefined", level: "fatal", severity: "critical", endpoint: "/api/cart", event_type: "TypeError", occurred_at: ago(30 * MIN), stack_trace: "TypeError: items\n    at addItem (/app/cart.ts:10:5)", attributes: { userId: 7 } }),
    buildEvent({ message: "Cart crash: items undefined", level: "fatal", severity: "critical", endpoint: "/api/cart", event_type: "TypeError", occurred_at: ago(10 * MIN) }),
  ]);
  const slow = await ingestEvents(service, a.projectId, [buildEvent({ message: "Search is slow", level: "warning", severity: "medium", endpoint: "/search", event_type: "Timeout", occurred_at: ago(2 * 60 * MIN) })]);
  const auth = await ingestEvents(service, a.projectId, [buildEvent({ message: "Token expired", level: "info", severity: "low", endpoint: "/account", event_type: "AuthError", occurred_at: ago(5 * MIN) })]);
  const other = await ingestEvents(service, b.projectId, [buildEvent({ message: "Private failure of user B", endpoint: "/b/secret" })]);
  // A resolved incident with a status history.
  await createPgRpc(admin, a.userId).rpc("change_incident_status", { p_id: slow[0].incident_id, p_to: "investigating", p_expected: "open" });
  await createPgRpc(admin, a.userId).rpc("change_incident_status", { p_id: slow[0].incident_id, p_to: "resolved", p_expected: "investigating" });

  seed = {
    userId: a.userId,
    projectId: a.projectId,
    ids: { cart: cart[0].incident_id, slow: slow[0].incident_id, auth: auth[0].incident_id },
    other: { userId: b.userId, incidentId: other[0].incident_id },
  };
});

afterAll(async () => {
  await admin.end();
  await service.end();
});
afterEach(() => {
  cleanup();
  world.ai = null;
});

const as = (userId: string) => {
  world.userId = userId;
};
/** Pages always render inside the app shell (it provides the context their buttons use), so tests do too. */
const renderPage = async (page: Promise<React.ReactNode>) => {
  const node = await page;
  const rows = (await (world.pool as pg.Pool).query("select id, name, environment from public.projects where owner_id = $1", [world.userId])).rows;
  const projects = rows.map((r) => ({ id: r.id, name: r.name, workspace: "Your projects", environment: r.environment }));
  return render(
    <AppShell projects={projects} unresolvedByProject={{}} userEmail="user@example.com">
      {node}
    </AppShell>,
  );
};
const sp = (q: Record<string, string> = {}) => ({ searchParams: Promise.resolve(q) }) as never;
const incidentProps = (id: string, q: Record<string, string> = {}) => ({ params: Promise.resolve({ incidentId: id }), searchParams: Promise.resolve(q) }) as never;

describe("incidents list page (real data)", () => {
  it("shows summary counters, every incident with real values, and a link to each detail page", async () => {
    as(seed.userId);
    await renderPage(IncidentsPage(sp()));

    const summary = within(screen.getByRole("region", { name: "Incident summary" }));
    expect(summary.getByText("Unresolved").closest("[data-slot=card]")).toHaveTextContent("2"); // cart + auth
    expect(summary.getByText("Critical").closest("[data-slot=card]")).toHaveTextContent("1");
    expect(summary.getByText("Recently resolved").closest("[data-slot=card]")).toHaveTextContent("1");

    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    const cart = screen.getByRole("link", { name: "Cart crash: items undefined" });
    expect(cart).toHaveAttribute("href", `/incidents/${seed.ids.cart}`);
    const cartRow = cart.closest("tr")!;
    expect(cartRow).toHaveTextContent("Critical");
    expect(cartRow).toHaveTextContent("Open");
    expect(cartRow).toHaveTextContent("2"); // occurrences
    expect(cartRow).toHaveTextContent("/api/cart");
    expect(screen.getByRole("navigation", { name: "Pagination" })).toHaveTextContent("Showing 1–3 of 3 incidents");
  });

  it("applies URL filters on the server", async () => {
    as(seed.userId);
    await renderPage(IncidentsPage(sp({ status: "resolved" })));
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Search is slow" })).toBeInTheDocument();
    expect(screen.getByLabelText("Status")).toHaveValue("resolved");
    cleanup();

    await renderPage(IncidentsPage(sp({ q: "CART", severity: "critical" })));
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(1);
  });

  it("sorts via header links that encode the next sort", async () => {
    as(seed.userId);
    await renderPage(IncidentsPage(sp({ sort: "occurrences", dir: "desc" })));
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByRole("link")).toHaveTextContent("Cart crash");
    const header = screen.getByRole("columnheader", { name: /Occurrences/ });
    expect(header).toHaveAttribute("aria-sort", "descending");
    expect(within(header).getByRole("link")).toHaveAttribute("href", "/incidents?sort=occurrences&dir=asc");
    expect(within(screen.getByRole("columnheader", { name: /Incident/ })).getByRole("link")).toHaveAttribute("href", expect.stringContaining("sort=title"));
  });

  it("shows a no-results state with a way out when filters match nothing", async () => {
    as(seed.userId);
    await renderPage(IncidentsPage(sp({ q: "zzz-nothing" })));
    expect(screen.getByText("No incidents match your filters")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows the 'send a test event' empty state for a user with no incidents", async () => {
    const empty = await createUserAndProject(admin, "empty");
    as(empty.userId);
    await renderPage(IncidentsPage(sp()));
    expect(screen.getByText("No incidents yet")).toBeInTheDocument();
  });

  it("never shows another user's incidents, even when their project id is requested", async () => {
    as(seed.other.userId);
    await renderPage(IncidentsPage(sp()));
    expect(screen.getByText("Private failure of user B")).toBeInTheDocument();
    expect(screen.queryByText("Cart crash: items undefined")).not.toBeInTheDocument();
    cleanup();
    await renderPage(IncidentsPage(sp({ project: seed.projectId })));
    expect(screen.queryByText("Cart crash: items undefined")).not.toBeInTheDocument();
  });

  it("survives junk parameters", async () => {
    as(seed.userId);
    await renderPage(IncidentsPage(sp({ status: "bogus", sort: "x;drop table", page: "-9", since: "forever", project: "../x" })));
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(3);
  });

  it("clamps a page number past the end to the last page", async () => {
    as(seed.userId);
    await renderPage(IncidentsPage(sp({ page: "99" })));
    expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
  });
});

describe("incident detail page (real data)", () => {
  it("renders header, summary, timeline, stack trace, related events and the AI panel", async () => {
    as(seed.userId);
    await renderPage(IncidentPage(incidentProps(seed.ids.cart)));

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Cart crash: items undefined");
    expect(screen.getByText("Critical")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("occurrences")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /All incidents/ })).toHaveAttribute("href", "/incidents");

    const summary = within(screen.getByRole("region", { name: "Summary" }));
    expect(summary.getByText("First seen")).toBeInTheDocument();
    expect(summary.getByText("Last seen")).toBeInTheDocument();
    expect(summary.getByText("/api/cart")).toBeInTheDocument();

    const timeline = within(screen.getByRole("list", { name: "Incident timeline" })).getAllByRole("listitem");
    expect(timeline.at(-1)).toHaveTextContent("First seen");
    expect(timeline[0]).toHaveTextContent("Cart crash: items undefined");

    expect(screen.getByRole("img", { name: /Occurrences over time: 2 in total/ })).toBeInTheDocument();
    expect(screen.getAllByLabelText("Stack trace text")[0]).toHaveTextContent("TypeError: items");
    const related = within(screen.getByRole("list", { name: "Related events" }));
    expect(related.getAllByRole("button", { expanded: false })).toHaveLength(2);

    expect(screen.getByRole("button", { name: "Acknowledge" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resolve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Investigate with AI" })).toBeDisabled(); // not configured here
    expect(screen.getByText(/not configured on this deployment/)).toBeInTheDocument();
  });

  it("enables Investigate with AI when configured", async () => {
    as(seed.userId);
    world.ai = { apiKey: "k", model: "m", timeoutMs: 1000 };
    await renderPage(IncidentPage(incidentProps(seed.ids.cart)));
    expect(screen.getByRole("button", { name: "Investigate with AI" })).toBeEnabled();
  });

  it("shows the persisted status history for a resolved incident, with Reopen as its action", async () => {
    as(seed.userId);
    await renderPage(IncidentPage(incidentProps(seed.ids.slow)));
    expect(screen.getByRole("button", { name: "Reopen" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Acknowledge" })).not.toBeInTheDocument();
    const timeline = screen.getByRole("list", { name: "Incident timeline" });
    expect(timeline).toHaveTextContent("Investigating → Resolved");
    expect(timeline).toHaveTextContent("Open → Investigating");
    expect(timeline).toHaveTextContent("You changed the status");
    expect(screen.getByText("Resolved")).toBeInTheDocument();
  });

  it("returns a 404 for malformed ids, unknown ids, and other users' incidents", async () => {
    as(seed.userId);
    await expect(IncidentPage(incidentProps("not-a-uuid"))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(IncidentPage(incidentProps("00000000-0000-4000-8000-000000000000"))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(IncidentPage(incidentProps(seed.other.incidentId))).rejects.toThrow("NEXT_NOT_FOUND");
    // ...and the owner can still open it, so the 404 above is authorization, not a broken id.
    as(seed.other.userId);
    await renderPage(IncidentPage(incidentProps(seed.other.incidentId)));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Private failure of user B");
  });

  it("paginates related events and preserves the project scope in links", async () => {
    as(seed.userId);
    await renderPage(IncidentPage(incidentProps(seed.ids.cart, { project: seed.projectId })));
    expect(screen.getByRole("link", { name: /All incidents/ })).toHaveAttribute("href", `/incidents?project=${seed.projectId}`);
    expect(screen.getByText(/All 2 events in this incident/)).toBeInTheDocument();
  });
});

describe("events page (real data)", () => {
  it("lists events newest first with level, type, endpoint, and expandable rows", async () => {
    as(seed.userId);
    await renderPage(EventsPage(sp()));
    const list = within(screen.getByRole("list", { name: "Events" }));
    expect(list.getAllByRole("button", { expanded: false })).toHaveLength(4);
    expect(list.getAllByText("Cart crash: items undefined")).toHaveLength(2);
    expect(screen.getByRole("navigation", { name: "Pagination" })).toHaveTextContent("of 4 events");
    // Filter options come from real data.
    const types = within(screen.getByLabelText("Event type")).getAllByRole("option").map((o) => o.textContent);
    expect(types).toEqual(expect.arrayContaining(["TypeError", "Timeout", "AuthError"]));
  });

  it("filters on the server by level, type, endpoint and time", async () => {
    as(seed.userId);
    await renderPage(EventsPage(sp({ level: "fatal" })));
    expect(within(screen.getByRole("list", { name: "Events" })).getAllByRole("button", { expanded: false })).toHaveLength(2);
    cleanup();
    await renderPage(EventsPage(sp({ type: "Timeout" })));
    expect(screen.getByText("Search is slow")).toBeInTheDocument();
    cleanup();
    await renderPage(EventsPage(sp({ endpoint: "api/ca" })));
    expect(within(screen.getByRole("list", { name: "Events" })).getAllByRole("button", { expanded: false })).toHaveLength(2);
    cleanup();
    await renderPage(EventsPage(sp({ since: "1h" })));
    expect(within(screen.getByRole("list", { name: "Events" })).getAllByRole("button", { expanded: false })).toHaveLength(3); // slow is 2h old
  });

  it("shows a no-results state, and the 'send a test event' state for a user with no events", async () => {
    as(seed.userId);
    await renderPage(EventsPage(sp({ q: "nothing-matches-this" })));
    expect(screen.getByText("No events match your filters")).toBeInTheDocument();
    cleanup();
    const empty = await createUserAndProject(admin, "no-events");
    as(empty.userId);
    await renderPage(EventsPage(sp()));
    expect(screen.getByText("No events yet")).toBeInTheDocument();
  });

  it("only shows the signed-in user's events", async () => {
    as(seed.other.userId);
    await renderPage(EventsPage(sp()));
    expect(screen.getByText("Private failure of user B")).toBeInTheDocument();
    expect(screen.queryByText("Cart crash: items undefined")).not.toBeInTheDocument();
  });
});

describe("dashboard page (real data)", () => {
  it("shows KPIs, charts and recent incidents computed from the database", async () => {
    as(seed.userId);
    await renderPage(DashboardPage(sp({ range: "24h" })));
    const kpis = within(screen.getByRole("region", { name: "Key metrics" }));
    // 4 events in 24h: 2 fatal + 1 warning + 1 info -> 2 error-level => 50%.
    expect(kpis.getByRole("heading", { name: "Total events" }).closest("[data-slot=card]")).toHaveTextContent("4");
    expect(kpis.getByRole("heading", { name: "Error rate" }).closest("[data-slot=card]")).toHaveTextContent("50.0%");
    expect(kpis.getByRole("heading", { name: "Unresolved incidents" }).closest("[data-slot=card]")).toHaveTextContent("2");
    expect(kpis.getByRole("heading", { name: "Affected endpoints" }).closest("[data-slot=card]")).toHaveTextContent("1");
    expect(screen.getByRole("img", { name: /Error rate over time/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Unresolved incidents by severity: 1 critical, 0 high, 0 medium, 1 low/ })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Critical"); // an unresolved critical incident
    expect(screen.getByRole("link", { name: "Cart crash: items undefined" })).toHaveAttribute("href", `/incidents/${seed.ids.cart}`);
  });
});

describe("stack trace selection", () => {
  it("shows the newest stack trace that exists, even when the latest event has none", async () => {
    const u = await createUserAndProject(admin, "trace");
    await ingestEvents(service, u.projectId, [
      buildEvent({ message: "Same failure", endpoint: "/e", occurred_at: ago(30 * MIN), stack_trace: "Error: old\n    at oldFrame (/app/old.ts:1:1)" }),
      buildEvent({ message: "Same failure", endpoint: "/e", occurred_at: ago(1 * MIN) }), // newest, no trace
    ]);
    const rows = (await admin.query("select i.id from public.incidents i where i.project_id = $1", [u.projectId])).rows;
    as(u.userId);
    await renderPage(IncidentPage(incidentProps(rows[0].id)));
    expect(screen.getAllByLabelText("Stack trace text")[0]).toHaveTextContent("Error: old");
    expect(screen.queryByText("No stack trace was captured for this event.")).not.toBeInTheDocument();
  });

  it("says so when no event of the incident has a trace", async () => {
    const u = await createUserAndProject(admin, "notrace");
    await ingestEvents(service, u.projectId, [buildEvent({ message: "No trace ever", endpoint: "/e" })]);
    const rows = (await admin.query("select i.id from public.incidents i where i.project_id = $1", [u.projectId])).rows;
    as(u.userId);
    await renderPage(IncidentPage(incidentProps(rows[0].id)));
    expect(screen.getByText("No stack trace was captured for this event.")).toBeInTheDocument();
  });
});
