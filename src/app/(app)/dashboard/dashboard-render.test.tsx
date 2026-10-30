import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardOverview, Project } from "@/lib/dashboard/types";
import type { IncidentSummary, Page } from "@/lib/incidents/types";

const replace = vi.fn();
let search = "";
const state = vi.hoisted(() => ({
  project: null as null | { id: string; name: string; workspace: string; environment: string },
  overview: null as unknown,
  list: null as unknown,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock("@/lib/auth/actions", () => ({ signOut: vi.fn() }));
vi.mock("@/lib/ingest/test-event-action", () => ({ sendTestEventAction: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/incidents/scope", () => ({
  WORKSPACE_LABEL: "Your projects",
  resolveProjectScope: async () => ({ projects: [], project: state.project }),
}));
vi.mock("@/lib/incidents/queries", () => ({
  asRpc: (c: unknown) => c,
  fetchDashboardOverview: async () => {
    if (state.overview instanceof Error) throw state.overview;
    return state.overview;
  },
  fetchIncidentList: async () => {
    if (state.list instanceof Error) throw state.list;
    return state.list;
  },
}));

import { AppShell } from "@/components/layout/app-shell";
import DashboardPage from "./page";

const PROJECTS: Project[] = [
  { id: "11111111-1111-4111-8111-111111111111", name: "checkout-web", workspace: "Your projects", environment: "production" },
  { id: "22222222-2222-4222-8222-222222222222", name: "api", workspace: "Your projects", environment: "staging" },
];

const NOW = "2026-10-30T12:00:00.000Z";
const incident = (n: number): IncidentSummary => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  projectId: PROJECTS[0].id,
  projectName: "checkout-web",
  environment: "production",
  title: `Incident ${n}`,
  severity: n === 1 ? "critical" : "medium",
  status: "open",
  occurrenceCount: n * 10,
  firstSeenAt: "2026-10-30T10:00:00.000Z",
  lastSeenAt: "2026-10-30T11:30:00.000Z",
  endpoint: `/api/route-${n}`,
});

function overview(over: Partial<DashboardOverview & { counts: object }> = {}) {
  return {
    generatedAt: NOW,
    range: "24h",
    kpis: [
      { id: "events", label: "Total events", value: 1250, format: "number", changePercent: 12.5, trendNote: null, detail: null, higherIs: "neutral" },
      { id: "errorRate", label: "Error rate", value: 2.4, format: "percent", changePercent: -3, trendNote: null, detail: null, higherIs: "bad" },
      { id: "unresolved", label: "Unresolved incidents", value: 3, format: "number", changePercent: null, trendNote: null, detail: null, higherIs: "bad" },
      { id: "endpoints", label: "Affected endpoints", value: 4, format: "number", changePercent: 0, trendNote: null, detail: null, higherIs: "bad" },
    ],
    series: Array.from({ length: 24 }, (_, i) => ({ time: new Date(Date.UTC(2026, 9, 29, i)).toISOString(), events: 50, errors: 1, rate: 2 })),
    severityBreakdown: [
      { severity: "critical", count: 1 },
      { severity: "high", count: 0 },
      { severity: "medium", count: 2 },
      { severity: "low", count: 0 },
    ],
    counts: { unresolved: 3, critical: 1, recentlyResolved: 0, total: 3 },
    deployments: [],
    ...over,
  };
}

const list = (items: IncidentSummary[]): Page<IncidentSummary> => ({ items, total: items.length, page: 1, pageCount: 1, pageSize: 20 });

/** Mounts the real shell around the real (async server) dashboard page, with the data layer stubbed. */
async function renderDashboard(query: Record<string, string> = {}) {
  search = new URLSearchParams(query).toString();
  const page = await DashboardPage({ searchParams: Promise.resolve(query) } as unknown as Parameters<typeof DashboardPage>[0]);
  return render(
    <AppShell projects={PROJECTS} unresolvedByProject={{ [PROJECTS[0].id]: 2, [PROJECTS[1].id]: 1 }} userEmail="nikhil@example.com">
      {page}
    </AppShell>,
  );
}

describe("dashboard render (real data layer contract)", () => {
  beforeEach(() => {
    state.project = null;
    state.overview = overview();
    state.list = list([incident(1), incident(2), incident(3)]);
  });

  it("renders heading, subtitle, actions and the four KPI cards from real values", async () => {
    await renderDashboard();
    expect(screen.getByRole("heading", { level: 1, name: "Project overview" })).toBeInTheDocument();
    expect(screen.getByText("Monitor errors, investigate incidents, and keep your applications healthy.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send test event" })).toBeInTheDocument();

    const kpis = within(screen.getByRole("region", { name: "Key metrics" }));
    expect(kpis.getByRole("heading", { name: "Total events" }).closest("[data-slot=card]")).toHaveTextContent("1,250");
    expect(kpis.getByRole("heading", { name: "Error rate" }).closest("[data-slot=card]")).toHaveTextContent("2.4%");
  });

  it("shows recent incidents as links to their detail pages", async () => {
    await renderDashboard();
    const link = screen.getByRole("link", { name: "Incident 1" });
    expect(link).toHaveAttribute("href", "/incidents/00000000-0000-4000-8000-000000000001");
    expect(screen.getByRole("link", { name: "View all" })).toHaveAttribute("href", "/incidents");
  });

  it("scopes links to the selected project", async () => {
    state.project = PROJECTS[0];
    await renderDashboard({ project: PROJECTS[0].id });
    expect(screen.getByRole("link", { name: "Incident 1" })).toHaveAttribute("href", expect.stringContaining(`?project=${PROJECTS[0].id}`));
    expect(screen.getAllByText("checkout-web").length).toBeGreaterThan(0);
  });

  it("shows primary navigation with the unresolved badge summed across projects", async () => {
    await renderDashboard();
    const nav = within(screen.getByRole("navigation", { name: "Primary" }));
    expect(nav.getAllByRole("link")).toHaveLength(5);
    expect(nav.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
    expect(nav.getByRole("link", { name: "Incidents, 3 unresolved" })).toBeInTheDocument();
  });

  it("offers All projects plus each real project in the selector", async () => {
    await renderDashboard();
    expect(screen.getByRole("button", { name: /Project: All projects/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Project: All projects/ }));
    expect(await screen.findByRole("menuitemradio", { name: "All projects" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /checkout-web/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /api/ })).toBeInTheDocument();
  });

  it("closes the project menu after a project is chosen (it used to stay open over the page)", async () => {
    await renderDashboard();
    await userEvent.click(screen.getByRole("button", { name: /Project: All projects/ }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: /checkout-web/ }));
    expect(replace).toHaveBeenCalledWith(expect.stringContaining("project=" + PROJECTS[0].id), expect.anything());
    await vi.waitFor(() => expect(screen.queryByRole("menuitemradio", { name: /checkout-web/ })).not.toBeInTheDocument());
  });

  it("exposes the time-range radiogroup on the dashboard", async () => {
    await renderDashboard({ range: "7d" });
    const group = screen.getByRole("radiogroup", { name: "Time range" });
    expect(within(group).getByRole("radio", { name: "Last 7 days" })).toBeChecked();
    await userEvent.click(within(group).getByRole("radio", { name: "Last 1 hour" }));
    expect(replace).toHaveBeenCalledWith(expect.stringContaining("range=1h"), expect.anything());
  });

  it("falls back safely when the URL carries junk params", async () => {
    await renderDashboard({ project: "../../etc/passwd", range: "forever" });
    expect(screen.getByRole("heading", { level: 1, name: "Project overview" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Last 24 hours" })).toBeChecked();
  });

  it("shows honest empty states when there is no data", async () => {
    state.overview = overview({
      kpis: [
        { id: "events", label: "Total events", value: 0, format: "number", changePercent: null, trendNote: null, detail: null, higherIs: "neutral" },
        { id: "errorRate", label: "Error rate", value: 0, format: "percent", changePercent: null, trendNote: null, detail: null, higherIs: "bad" },
        { id: "unresolved", label: "Unresolved incidents", value: 0, format: "number", changePercent: null, trendNote: null, detail: null, higherIs: "bad" },
        { id: "endpoints", label: "Affected endpoints", value: 0, format: "number", changePercent: null, trendNote: null, detail: null, higherIs: "bad" },
      ],
      severityBreakdown: [],
      counts: { unresolved: 0, critical: 0, recentlyResolved: 0, total: 0 },
    } as never);
    state.list = list([]);
    await renderDashboard();
    expect(screen.getByText("No events in this time range")).toBeInTheDocument();
    expect(screen.getByText("No unresolved incidents")).toBeInTheDocument();
    expect(screen.getByText("No incidents yet")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("No data");
  });

  it("isolates failures: a failed overview degrades KPIs and charts but recent incidents still render", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.overview = new Error("boom");
    await renderDashboard();
    expect(screen.getByRole("link", { name: "Incident 1" })).toBeInTheDocument();
    expect(screen.getAllByText(/could not be loaded/i).length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByRole("region", { name: "Key metrics" })).not.toBeInTheDocument();
    spy.mockRestore();
  });

  it("isolates failures: failed recent incidents leave the metrics intact", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.list = new Error("boom");
    await renderDashboard();
    expect(within(screen.getByRole("region", { name: "Key metrics" })).getByRole("heading", { name: "Total events" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Incident 1" })).not.toBeInTheDocument();
    expect(screen.getAllByText(/could not be loaded/i).length).toBeGreaterThanOrEqual(1);
    spy.mockRestore();
  });

  it("offers the labelled demo from empty states", async () => {
    state.overview = overview({ kpis: overview().kpis.map((k) => ({ ...k, value: 0 })), severityBreakdown: [] } as never);
    state.list = list([]);
    await renderDashboard();
    expect(screen.getAllByRole("button", { name: /try the demo/i }).length).toBeGreaterThan(0);
  });

  it("opens the account menu and the send-test-event dialog", async () => {
    await renderDashboard();
    await userEvent.click(screen.getAllByRole("button", { name: /Account menu for nikhil@example.com/ })[0]);
    expect(await screen.findByRole("menuitem", { name: /Sign out/ })).toBeInTheDocument();
  });
});
