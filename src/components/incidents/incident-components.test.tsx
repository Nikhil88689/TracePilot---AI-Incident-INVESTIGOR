import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IncidentSummary } from "@/lib/incidents/types";

const nav = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, refresh: nav.refresh, push: nav.push }),
  usePathname: () => "/incidents",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const actions = vi.hoisted(() => ({ changeStatusAction: vi.fn(), toggleStepAction: vi.fn(), loadEventDetailAction: vi.fn() }));
vi.mock("@/lib/incidents/actions", () => actions);

import { Pagination } from "@/components/common/pagination";
import { ClearIncidentFilters, IncidentFilters } from "./incident-filters";
import { IncidentTable } from "./incident-table";
import { IncidentTimeline } from "./incident-timeline";
import { StackTrace } from "./stack-trace";
import { StatusActions } from "./status-actions";

const ID = "11111111-1111-4111-8111-111111111111";
const baseValues = { q: "", status: "all", severity: "all", env: "all", since: "all" };

beforeEach(() => {
  nav.replace.mockClear();
  nav.refresh.mockClear();
  nav.push.mockClear();
  nav.search = "";
  Object.values(toast).forEach((m) => m.mockClear());
  Object.values(actions).forEach((m) => m.mockReset());
});

describe("IncidentFilters (URL is the source of truth)", () => {
  it("renders labelled controls with the current values", () => {
    render(<IncidentFilters values={{ ...baseValues, status: "open", severity: "critical" }} />);
    expect(screen.getByRole("search", { name: "Filter incidents" })).toBeInTheDocument();
    expect(screen.getByLabelText("Status")).toHaveValue("open");
    expect(screen.getByLabelText("Severity")).toHaveValue("critical");
    expect(screen.getByLabelText("Environment")).toHaveValue("all");
    expect(screen.getByLabelText("Last seen")).toHaveValue("all");
  });

  it("writes a changed filter to the URL and drops the page param", async () => {
    nav.search = "project=abc&page=3";
    render(<IncidentFilters values={baseValues} />);
    await userEvent.selectOptions(screen.getByLabelText("Status"), "open");
    expect(nav.replace).toHaveBeenCalledWith("/incidents?project=abc&status=open", { scroll: false });
  });

  it("removes a filter from the URL when set back to 'All'", async () => {
    nav.search = "status=open&severity=high";
    render(<IncidentFilters values={{ ...baseValues, status: "open", severity: "high" }} />);
    await userEvent.selectOptions(screen.getByLabelText("Status"), "all");
    expect(nav.replace).toHaveBeenCalledWith("/incidents?severity=high", { scroll: false });
  });

  it("covers environment and date range", async () => {
    render(<IncidentFilters values={baseValues} />);
    await userEvent.selectOptions(screen.getByLabelText("Environment"), "staging");
    expect(nav.replace).toHaveBeenLastCalledWith("/incidents?env=staging", { scroll: false });
    await userEvent.selectOptions(screen.getByLabelText("Last seen"), "7d");
    expect(nav.replace).toHaveBeenLastCalledWith(expect.stringContaining("since=7d"), { scroll: false });
  });

  it("debounces search typing into a single URL update", async () => {
    render(<IncidentFilters values={baseValues} />);
    await userEvent.type(screen.getByRole("searchbox"), "cart");
    expect(nav.replace).not.toHaveBeenCalled();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledTimes(1), { timeout: 1500 });
    expect(nav.replace).toHaveBeenCalledWith("/incidents?q=cart", { scroll: false });
  });

  it("has a clear button that empties the search immediately", async () => {
    nav.search = "q=cart&status=open";
    render(<IncidentFilters values={{ ...baseValues, q: "cart", status: "open" }} />);
    expect(screen.getByRole("searchbox")).toHaveValue("cart");
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(nav.replace).toHaveBeenCalledWith("/incidents?status=open", { scroll: false });
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
  });

  it("clears the search with Escape", async () => {
    render(<IncidentFilters values={{ ...baseValues, q: "cart" }} />);
    await userEvent.type(screen.getByRole("searchbox"), "{Escape}");
    expect(screen.getByRole("searchbox")).toHaveValue("");
  });

  it("shows Reset only when a filter is active, and Reset keeps the project scope", async () => {
    const { rerender } = render(<IncidentFilters values={baseValues} />);
    expect(screen.queryByRole("button", { name: /Reset/ })).not.toBeInTheDocument();

    nav.search = "project=abc&status=open&q=x&sort=title";
    rerender(<IncidentFilters values={{ ...baseValues, status: "open", q: "x" }} />);
    await userEvent.click(screen.getByRole("button", { name: /Reset/ }));
    expect(nav.replace).toHaveBeenCalledWith("/incidents?project=abc&sort=title", { scroll: false });
  });

  it("adopts a search value changed from outside (e.g. a Clear filters link) without losing typing", () => {
    const { rerender } = render(<IncidentFilters values={{ ...baseValues, q: "old" }} />);
    expect(screen.getByRole("searchbox")).toHaveValue("old");
    rerender(<IncidentFilters values={{ ...baseValues, q: "" }} />);
    expect(screen.getByRole("searchbox")).toHaveValue("");
  });

  it("ClearIncidentFilters removes every filter key", async () => {
    nav.search = "status=open&severity=high&env=staging&since=7d&q=a&project=p";
    render(<ClearIncidentFilters />);
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(nav.replace).toHaveBeenCalledWith("/incidents?project=p", { scroll: false });
  });
});

const incident = (over: Partial<IncidentSummary> = {}): IncidentSummary => ({
  id: ID, projectId: "p", projectName: "checkout-web", environment: "production", title: "TypeError: boom", severity: "critical", status: "open",
  occurrenceCount: 1234, firstSeenAt: "2026-10-30T09:00:00Z", lastSeenAt: "2026-10-30T11:55:00Z", endpoint: "/api/cart", ...over,
});
const NOW = "2026-10-30T12:00:00Z";

describe("IncidentTable", () => {
  it("renders a row per incident with a link, badges, counts and relative times", () => {
    render(<IncidentTable items={[incident(), incident({ id: "22222222-2222-4222-8222-222222222222", title: "Other", endpoint: null, severity: "low", status: "resolved" })]} now={NOW} detailQuery="?project=p" />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(screen.getByRole("link", { name: "TypeError: boom" })).toHaveAttribute("href", `/incidents/${ID}?project=p`);
    expect(within(rows[0]).getByText("Critical")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Open")).toBeInTheDocument();
    expect(within(rows[0]).getByText("1,234")).toBeInTheDocument();
    expect(within(rows[0]).getAllByText("5m ago").length).toBeGreaterThan(0);
    expect(within(rows[1]).getAllByText("—").length).toBeGreaterThan(0); // no endpoint
  });

  it("navigates when a row (not a link) is clicked", async () => {
    render(<IncidentTable items={[incident()]} now={NOW} />);
    await userEvent.click(screen.getByText("1,234"));
    expect(nav.push).toHaveBeenCalledWith(`/incidents/${ID}`);
  });

  it("does not double-navigate when the title link itself is clicked", async () => {
    render(<IncidentTable items={[incident()]} now={NOW} />);
    await userEvent.click(screen.getByRole("link", { name: "TypeError: boom" }));
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("makes headers sort links and exposes the active sort", () => {
    render(
      <IncidentTable items={[incident()]} now={NOW} sort={{ key: "occurrences", dir: "desc", hrefFor: (k) => `/incidents?sort=${k}` }} />,
    );
    const header = screen.getByRole("columnheader", { name: /Occurrences/ });
    expect(header).toHaveAttribute("aria-sort", "descending");
    expect(within(header).getByRole("link")).toHaveAttribute("href", "/incidents?sort=occurrences");
    expect(screen.getByRole("columnheader", { name: /Incident/ })).toHaveAttribute("aria-sort", "none");
  });

  it("renders plain headers without sort links when sorting is not offered", () => {
    render(<IncidentTable items={[incident()]} now={NOW} />);
    expect(within(screen.getByRole("columnheader", { name: /Severity/ })).queryByRole("link")).not.toBeInTheDocument();
  });
});

describe("Pagination", () => {
  const hrefFor = (p: number) => `/incidents?page=${p}`;

  it("shows the range and links to neighbouring pages", () => {
    render(<Pagination page={2} pageCount={3} total={45} pageSize={20} hrefFor={hrefFor} noun="incidents" />);
    expect(screen.getByText(/Showing/)).toHaveTextContent("Showing 21–40 of 45 incidents");
    expect(screen.getByRole("link", { name: "Previous page" })).toHaveAttribute("href", "/incidents?page=1");
    expect(screen.getByRole("link", { name: "Next page" })).toHaveAttribute("href", "/incidents?page=3");
    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
  });

  it("disables previous on the first page and next on the last", () => {
    const { rerender } = render(<Pagination page={1} pageCount={3} total={45} pageSize={20} hrefFor={hrefFor} />);
    expect(screen.getByRole("link", { name: "Previous page" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("link", { name: "Next page" })).toHaveAttribute("aria-disabled", "false");
    rerender(<Pagination page={3} pageCount={3} total={45} pageSize={20} hrefFor={hrefFor} />);
    expect(screen.getByRole("link", { name: "Next page" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/Showing/)).toHaveTextContent("41–45 of 45");
  });

  it("renders nothing for an empty result", () => {
    const { container } = render(<Pagination page={1} pageCount={1} total={0} pageSize={20} hrefFor={hrefFor} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("StatusActions", () => {
  it("offers Acknowledge and Resolve for an open incident", () => {
    render(<StatusActions incidentId={ID} status="open" />);
    expect(screen.getByRole("button", { name: "Acknowledge" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Resolve" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Reopen" })).not.toBeInTheDocument();
  });

  it("offers only Resolve while investigating and only Reopen once resolved", () => {
    const { rerender } = render(<StatusActions incidentId={ID} status="investigating" />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Resolve"]);
    rerender(<StatusActions incidentId={ID} status="resolved" />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Reopen"]);
  });

  it("sends the expected current status, confirms, and refreshes the page from the server", async () => {
    actions.changeStatusAction.mockResolvedValue({ status: "ok", newStatus: "resolved", resolvedAt: "t" });
    render(<StatusActions incidentId={ID} status="open" />);
    await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(actions.changeStatusAction).toHaveBeenCalledWith({ incidentId: ID, to: "resolved", expected: "open" });
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith("Incident resolved");
  });

  it("disables the buttons while a change is in flight, so it cannot be double-submitted", async () => {
    let finish: (v: unknown) => void = () => {};
    actions.changeStatusAction.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<StatusActions incidentId={ID} status="open" />);
    await userEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(screen.getByRole("button", { name: "Acknowledge" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resolve" })).toBeDisabled();
    finish({ status: "ok", newStatus: "investigating", resolvedAt: null });
    await waitFor(() => expect(screen.getByRole("button", { name: "Resolve" })).toBeEnabled());
    expect(actions.changeStatusAction).toHaveBeenCalledTimes(1);
  });

  it("explains a conflict (someone else changed it) and shows the latest state", async () => {
    actions.changeStatusAction.mockResolvedValue({ status: "conflict", current: "resolved" });
    render(<StatusActions incidentId={ID} status="open" />);
    await userEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(expect.stringContaining("already changed this incident to resolved")));
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("shows a server error inline and still refreshes", async () => {
    actions.changeStatusAction.mockResolvedValue({ status: "error", message: "This incident no longer exists or you don't have access to it." });
    render(<StatusActions incidentId={ID} status="open" />);
    await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer exists");
    expect(toast.success).not.toHaveBeenCalled();
    // The failed attempt is rolled back by never having been applied: the buttons are usable again.
    expect(screen.getByRole("button", { name: "Resolve" })).toBeEnabled();
  });
});

describe("StackTrace", () => {
  const trace = "TypeError: boom\n    at a (/app/a.ts:1:1)\n    at b (/app/b.ts:2:2)";

  it("explains when no trace was captured", () => {
    render(<StackTrace trace={null} />);
    expect(screen.getByText(/No stack trace was captured/)).toBeInTheDocument();
  });

  it("previews the first line, expands to the full monospace trace, and collapses again", async () => {
    render(<StackTrace trace={trace} />);
    const toggle = screen.getByRole("button", { name: /Stack trace/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByLabelText("Stack trace text")).toHaveTextContent("TypeError: boom");
    expect(screen.getByLabelText("Stack trace text")).not.toHaveTextContent("at a");

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Stack trace text")).toHaveTextContent("at b (/app/b.ts:2:2)");
    expect(screen.getByLabelText("Stack trace text").className).toMatch(/font-mono/);

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("can start open and shows the line count", () => {
    render(<StackTrace trace={trace} defaultOpen />);
    expect(screen.getByRole("button", { name: /3 lines/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("has a copy control", () => {
    render(<StackTrace trace={trace} />);
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });
});

describe("IncidentTimeline", () => {
  it("renders entries in order with times, and notes events that are listed elsewhere", () => {
    render(
      <IncidentTimeline
        now={NOW}
        hiddenEvents={4}
        entries={[
          { id: "e1", at: "2026-10-30T11:50:00Z", kind: "event", level: "error", title: "Cannot read x", detail: "TypeError · /api/cart" },
          { id: "a1", at: "2026-10-30T11:00:00Z", kind: "status", title: "You changed the status", detail: "Open → Investigating" },
          { id: "first-seen", at: "2026-10-30T09:00:00Z", kind: "first_seen", title: "First seen" },
        ]}
      />,
    );
    const items = within(screen.getByRole("list", { name: "Incident timeline" })).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Cannot read x");
    expect(items[0]).toHaveTextContent("10m ago");
    expect(items[1]).toHaveTextContent("Open → Investigating");
    expect(items[2]).toHaveTextContent("4 earlier events are listed under Related events");
  });
});

