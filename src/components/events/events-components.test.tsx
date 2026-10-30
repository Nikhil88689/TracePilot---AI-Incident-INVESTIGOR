import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventDetail, EventSummary } from "@/lib/incidents/types";

const nav = vi.hoisted(() => ({ replace: vi.fn(), search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/events",
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const actions = vi.hoisted(() => ({ loadEventDetailAction: vi.fn() }));
vi.mock("@/lib/incidents/actions", () => actions);

import { EventFilters } from "./event-filters";
import { EventRow } from "./event-row";

const EVENT: EventSummary = {
  id: "11111111-1111-4111-8111-111111111111", projectId: "p", projectName: "checkout-web", externalEventId: "evt_abc123", eventType: "TypeError", level: "error",
  message: "Cannot read properties of undefined", endpoint: "/api/cart", occurredAt: "2026-10-30T11:55:00.000Z",
  incidentId: "22222222-2222-4222-8222-222222222222", incidentTitle: "TypeError: Cannot read",
};
const DETAIL: EventDetail = { ...EVENT, stackTrace: "TypeError: x\n    at f (/app/f.ts:1:1)", attributes: { userId: 42, plan: "pro" } };
const NOW = "2026-10-30T12:00:00.000Z";

beforeEach(() => {
  actions.loadEventDetailAction.mockReset();
  nav.replace.mockClear();
  nav.search = "";
});

describe("EventRow", () => {
  it("shows level, message, type, endpoint and relative time while collapsed, without fetching", () => {
    render(<ul><EventRow event={EVENT} now={NOW} /></ul>);
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText("Cannot read properties of undefined")).toBeInTheDocument();
    expect(screen.getByText("TypeError")).toBeInTheDocument();
    expect(screen.getByText("/api/cart")).toBeInTheDocument();
    expect(screen.getByText("5m ago")).toBeInTheDocument();
    expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument();
    expect(actions.loadEventDetailAction).not.toHaveBeenCalled();
  });

  it("loads details on first expand: attributes, stack trace, linked incident, and copy controls", async () => {
    actions.loadEventDetailAction.mockResolvedValue({ status: "ok", event: DETAIL });
    render(<ul><EventRow event={EVENT} now={NOW} linkQuery="?project=p" /></ul>);
    await userEvent.click(screen.getByRole("button", { expanded: false }));

    expect(actions.loadEventDetailAction).toHaveBeenCalledWith({ eventId: EVENT.id });
    const panel = await screen.findByRole("region", { name: "Event details" });
    expect(within(panel).getByText("evt_abc123")).toBeInTheDocument();
    expect(within(panel).getByText("2026-10-30T11:55:00.000Z")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Copy ID" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Copy timestamp" })).toBeInTheDocument();
    expect(within(panel).getByLabelText("Event attributes")).toHaveTextContent('"userId": 42');
    expect(within(panel).getByLabelText("Stack trace text")).toHaveTextContent("at f (/app/f.ts:1:1)");
    expect(within(panel).getByRole("link", { name: "TypeError: Cannot read" })).toHaveAttribute("href", `/incidents/${EVENT.incidentId}?project=p`);
  });

  it("does not refetch when collapsed and expanded again", async () => {
    actions.loadEventDetailAction.mockResolvedValue({ status: "ok", event: DETAIL });
    render(<ul><EventRow event={EVENT} now={NOW} /></ul>);
    const toggle = screen.getByRole("button", { expanded: false });
    await userEvent.click(toggle);
    await screen.findByRole("region", { name: "Event details" });
    await userEvent.click(screen.getByRole("button", { name: /Cannot read properties of undefined/, expanded: true }));
    expect(screen.queryByRole("region", { name: "Event details" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { expanded: false }));
    expect(await screen.findByRole("region", { name: "Event details" })).toBeInTheDocument();
    expect(actions.loadEventDetailAction).toHaveBeenCalledTimes(1);
  });

  it("shows a load error with a working retry", async () => {
    actions.loadEventDetailAction.mockResolvedValueOnce({ status: "error", message: "Could not load the event. Please try again." }).mockResolvedValueOnce({ status: "ok", event: DETAIL });
    render(<ul><EventRow event={EVENT} now={NOW} /></ul>);
    await userEvent.click(screen.getByRole("button", { expanded: false }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the event");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("evt_abc123")).toBeInTheDocument();
    expect(actions.loadEventDetailAction).toHaveBeenCalledTimes(2);
  });

  it("survives a network failure while loading", async () => {
    actions.loadEventDetailAction.mockRejectedValue(new Error("offline"));
    render(<ul><EventRow event={EVENT} now={NOW} /></ul>);
    await userEvent.click(screen.getByRole("button", { expanded: false }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Check your connection");
  });

  it("omits attributes and the incident link when there are none, and says when no trace was captured", async () => {
    actions.loadEventDetailAction.mockResolvedValue({ status: "ok", event: { ...DETAIL, attributes: {}, stackTrace: null, incidentId: null, incidentTitle: null } });
    render(<ul><EventRow event={EVENT} now={NOW} /></ul>);
    await userEvent.click(screen.getByRole("button", { expanded: false }));
    await screen.findByRole("region", { name: "Event details" });
    expect(screen.queryByLabelText("Event attributes")).not.toBeInTheDocument();
    expect(screen.getByText("Not linked to an incident")).toBeInTheDocument();
    expect(screen.getByText(/No stack trace was captured/)).toBeInTheDocument();
  });

  it("hides the incident field on an incident's own page", async () => {
    actions.loadEventDetailAction.mockResolvedValue({ status: "ok", event: DETAIL });
    render(<ul><EventRow event={EVENT} now={NOW} showIncident={false} /></ul>);
    await userEvent.click(screen.getByRole("button", { expanded: false }));
    await screen.findByRole("region", { name: "Event details" });
    expect(screen.queryByText("Incident")).not.toBeInTheDocument();
  });

  it("copies the event id and timestamp to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    actions.loadEventDetailAction.mockResolvedValue({ status: "ok", event: DETAIL });
    render(<ul><EventRow event={EVENT} now={NOW} /></ul>);
    await userEvent.click(screen.getByRole("button", { expanded: false }));
    await userEvent.click(await screen.findByRole("button", { name: "Copy ID" }));
    expect(writeText).toHaveBeenLastCalledWith("evt_abc123");
    await userEvent.click(screen.getByRole("button", { name: "Copy timestamp" }));
    expect(writeText).toHaveBeenLastCalledWith("2026-10-30T11:55:00.000Z");
  });
});

describe("EventFilters", () => {
  const options = { eventTypes: ["TypeError", "Timeout"], endpoints: ["/api/cart", "/search"] };
  const projects = [{ id: "33333333-3333-4333-8333-333333333333", name: "checkout-web" }];
  const values = { q: "", type: "", level: "all", endpoint: "", since: "all", project: "" };

  it("renders every filter from the spec, labelled", () => {
    render(<EventFilters values={values} options={options} projects={projects} />);
    expect(screen.getByRole("searchbox")).toBeInTheDocument();
    for (const label of ["Project", "Event type", "Level", "Time", "Endpoint"]) expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(within(screen.getByLabelText("Event type")).getAllByRole("option").map((o) => o.textContent)).toEqual(["All types", "TypeError", "Timeout"]);
  });

  it("writes each filter to the URL", async () => {
    render(<EventFilters values={values} options={options} projects={projects} />);
    await userEvent.selectOptions(screen.getByLabelText("Event type"), "Timeout");
    expect(nav.replace).toHaveBeenLastCalledWith("/events?type=Timeout", { scroll: false });
    await userEvent.selectOptions(screen.getByLabelText("Level"), "fatal");
    expect(nav.replace).toHaveBeenLastCalledWith(expect.stringContaining("level=fatal"), { scroll: false });
    await userEvent.selectOptions(screen.getByLabelText("Time"), "24h");
    expect(nav.replace).toHaveBeenLastCalledWith(expect.stringContaining("since=24h"), { scroll: false });
    await userEvent.selectOptions(screen.getByLabelText("Project"), "checkout-web");
    expect(nav.replace).toHaveBeenLastCalledWith(expect.stringContaining("project=33333333"), { scroll: false });
  });

  it("debounces the endpoint text filter and offers known endpoints as suggestions", async () => {
    const { container } = render(<EventFilters values={values} options={options} projects={projects} />);
    expect(container.querySelectorAll("datalist option")).toHaveLength(2);
    await userEvent.type(screen.getByLabelText("Endpoint"), "/api");
    expect(nav.replace).not.toHaveBeenCalled();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledTimes(1), { timeout: 1500 });
    expect(nav.replace).toHaveBeenCalledWith("/events?endpoint=%2Fapi", { scroll: false });
  });

  it("keeps a filtered type selectable even if it is not among the suggestions", () => {
    render(<EventFilters values={{ ...values, type: "RareError" }} options={options} projects={projects} />);
    expect(screen.getByLabelText("Event type")).toHaveValue("RareError");
  });

  it("offers Reset when a filter is active and keeps the project scope", async () => {
    nav.search = "project=p&level=fatal&q=x";
    render(<EventFilters values={{ ...values, level: "fatal", q: "x", project: "p" }} options={options} projects={projects} />);
    await userEvent.click(screen.getByRole("button", { name: /Reset/ }));
    expect(nav.replace).toHaveBeenCalledWith("/events?project=p", { scroll: false });
  });
});
