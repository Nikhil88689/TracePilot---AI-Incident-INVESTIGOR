import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ project: null as null | { id: string; name: string; isDemo: boolean } }));
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));
const actions = vi.hoisted(() => ({ startDemoAction: vi.fn(), removeDemoAction: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/layout/shell-context", () => ({ useDashboardParams: () => ({ project: state.project, range: "24h" }) }));
vi.mock("@/lib/demo/actions", () => actions);

import { DemoBanner } from "./demo-banner";
import { DEMO_CALLOUT_KEY, DemoCallout } from "./demo-callout";

beforeEach(() => {
  state.project = { id: "p1", name: "Demo (simulated storefront)", isDemo: true };
  Object.values(router).forEach((f) => f.mockReset());
  Object.values(actions).forEach((f) => f.mockReset());
  window.localStorage.clear();
});

describe("DemoCallout", () => {
  it("shows a short hint inside the demo project only", () => {
    const { rerender } = render(<DemoCallout step="dashboard" incidentsHref="/incidents?status=unresolved" />);
    expect(screen.getByRole("complementary", { name: "Demo hint" })).toHaveTextContent(/spiked/);
    expect(screen.getByRole("link", { name: /Open the incident/ })).toHaveAttribute("href", "/incidents?status=unresolved");

    state.project = { id: "p2", name: "Real", isDemo: false };
    rerender(<DemoCallout step="dashboard" incidentsHref="/x" />);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    state.project = null;
    rerender(<DemoCallout step="dashboard" incidentsHref="/x" />);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("is dismissible and stays dismissed", async () => {
    const { unmount } = render(<DemoCallout step="incident" />);
    expect(screen.getByRole("complementary")).toHaveTextContent(/stack trace/);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss demo hint" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(DEMO_CALLOUT_KEY)).toBeTruthy();
    unmount();
    render(<DemoCallout step="dashboard" incidentsHref="/x" />);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });
});

describe("DemoBanner", () => {
  it("is always visible in the demo project, labelled simulated, with no dismiss control", () => {
    render(<DemoBanner />);
    expect(screen.getByRole("note", { name: "Simulated demo data" })).toHaveTextContent(/not real\s+production monitoring/);
    expect(screen.queryByRole("button", { name: /dismiss|close/i })).not.toBeInTheDocument();
  });

  it("renders nothing for real projects", () => {
    state.project = { id: "p2", name: "Real", isDemo: false };
    const { container } = render(<DemoBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("asks before resetting, then rebuilds and opens the new project", async () => {
    actions.startDemoAction.mockResolvedValue({ status: "ok", projectId: "p9", created: true });
    render(<DemoBanner />);
    await userEvent.click(screen.getByRole("button", { name: /Reset demo/ }));
    expect(actions.startDemoAction).not.toHaveBeenCalled(); // nothing happens until confirmed
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reset demo" }));
    await waitFor(() => expect(actions.startDemoAction).toHaveBeenCalledWith({ reset: true }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/dashboard?project=p9"));
  });

  it("cancel leaves everything untouched", async () => {
    render(<DemoBanner />);
    await userEvent.click(screen.getByRole("button", { name: /Remove demo/ }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(actions.removeDemoAction).not.toHaveBeenCalled();
  });

  it("removes the demo and returns to the real dashboard, or shows the error", async () => {
    actions.removeDemoAction.mockResolvedValueOnce({ status: "error", message: "Could not remove the demo. Please try again." });
    render(<DemoBanner />);
    await userEvent.click(screen.getByRole("button", { name: /Remove demo/ }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove demo" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not remove the demo");
    expect(router.push).not.toHaveBeenCalled();

    actions.removeDemoAction.mockResolvedValueOnce({ status: "ok", removed: true });
    // the first attempt is still settling (pending transition): wait until the button is usable again
    const retry = within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove demo" });
    await waitFor(() => expect(retry).toBeEnabled());
    await userEvent.click(retry);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/dashboard"));
  });
});

