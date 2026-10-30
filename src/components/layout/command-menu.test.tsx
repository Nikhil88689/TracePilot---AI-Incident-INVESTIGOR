import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
const shell = vi.hoisted(() => ({ demoProjectId: null as string | null, openDemo: vi.fn(), openTestEvent: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("./shell-context", () => ({
  useShell: () => ({ projects: [{ id: "p1", name: "checkout-web" }], ...shell }),
  useDashboardParams: () => ({ projectId: null, hrefFor: (href: string, extra?: Record<string, string>) => `${href}${extra?.project ? `?project=${extra.project}` : ""}` }),
}));

// Real cmdk and Base UI dialog (no mocking of the UI kit): this is the regression test for the palette crashing on open.
import { CommandMenu } from "./command-menu";

// jsdom lacks these browser APIs that cmdk uses.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => undefined;

beforeEach(() => {
  push.mockReset();
  shell.openDemo.mockReset();
  shell.openTestEvent.mockReset();
  shell.demoProjectId = null;
});

describe("CommandMenu", () => {
  it("opens without crashing and lists pages, projects and actions", async () => {
    render(<CommandMenu open onOpenChange={() => undefined} />);
    expect(await screen.findByRole("dialog", { name: "Search and commands" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Overview/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /checkout-web/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Try the demo/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Send test event/ })).toBeInTheDocument();
  });

  it("filters as you type and shows an empty state", async () => {
    render(<CommandMenu open onOpenChange={() => undefined} />);
    const input = await screen.findByPlaceholderText(/Search pages/);
    await userEvent.type(input, "incid");
    expect(screen.getByRole("option", { name: /Incidents/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Events/ })).not.toBeInTheDocument();
    await userEvent.clear(input);
    await userEvent.type(input, "zzzz");
    expect(screen.getByText("No matching results.")).toBeInTheDocument();
  });

  it("runs a command, closes, and navigates", async () => {
    const onOpenChange = vi.fn();
    render(<CommandMenu open onOpenChange={onOpenChange} />);
    await userEvent.click(await screen.findByRole("option", { name: /Incidents/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(push).toHaveBeenCalledWith("/incidents");
  });

  it("offers the demo consent dialog, or opens an existing demo", async () => {
    const { unmount } = render(<CommandMenu open onOpenChange={() => undefined} />);
    await userEvent.click(await screen.findByRole("option", { name: /Try the demo/ }));
    expect(shell.openDemo).toHaveBeenCalled();
    unmount();
    shell.demoProjectId = "d1";
    render(<CommandMenu open onOpenChange={() => undefined} />);
    await userEvent.click(await screen.findByRole("option", { name: /Open the demo/ }));
    expect(push).toHaveBeenCalledWith("/dashboard?project=d1");
  });

  it("toggles with Ctrl+K", async () => {
    const onOpenChange = vi.fn();
    render(<CommandMenu open={false} onOpenChange={onOpenChange} />);
    await userEvent.keyboard("{Control>}k{/Control}");
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});
