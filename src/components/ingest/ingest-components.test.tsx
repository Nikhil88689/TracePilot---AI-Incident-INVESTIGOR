import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiKeyRecord } from "@/lib/ingest/key-service";

const mocks = vi.hoisted(() => ({
  createApiKeyAction: vi.fn(),
  revokeApiKeyAction: vi.fn(),
  sendTestEventAction: vi.fn(),
}));
vi.mock("@/lib/ingest/key-actions", () => ({
  createApiKeyAction: mocks.createApiKeyAction,
  revokeApiKeyAction: mocks.revokeApiKeyAction,
}));
vi.mock("@/lib/ingest/test-event-action", () => ({ sendTestEventAction: mocks.sendTestEventAction }));

import { ApiKeyManager } from "./api-key-manager";
import { TestEventPanel } from "./test-event-panel";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const KEY = "tp_live_" + "Z".repeat(43);
const record = (over: Partial<ApiKeyRecord> = {}): ApiKeyRecord => ({
  id: "22222222-2222-4222-8222-222222222222",
  project_id: PROJECT,
  name: "Production server",
  key_prefix: "tp_live_ZZZZ",
  created_at: "2026-10-29T10:00:00Z",
  last_used_at: null,
  revoked_at: null,
  ...over,
});

describe("ApiKeyManager", () => {
  beforeEach(() => Object.values(mocks).forEach((m) => m.mockReset()));

  it("shows an empty state when there are no keys", () => {
    render(<ApiKeyManager projectId={PROJECT} initialKeys={[]} />);
    expect(screen.getByText(/No API keys yet/)).toBeInTheDocument();
  });

  it("reveals the new key exactly once, then hides it for good", async () => {
    mocks.createApiKeyAction.mockResolvedValue({ status: "success", key: KEY, record: record({ id: "new" }) });
    render(<ApiKeyManager projectId={PROJECT} initialKeys={[]} />);

    await userEvent.click(screen.getByRole("button", { name: "Create API key" }));
    expect(mocks.createApiKeyAction).toHaveBeenCalledWith({ projectId: PROJECT, name: "Production server" });

    expect(await screen.findByLabelText("New API key")).toHaveValue(KEY);
    expect(screen.getByRole("alert")).toHaveTextContent("won't be shown again");
    // The list shows only the prefix, never the full key.
    const list = within(screen.getByRole("list", { name: "API keys" }));
    expect(list.getByText(/tp_live_ZZZZ…/)).toBeInTheDocument();
    expect(list.queryByText(KEY)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "I've saved it" }));
    expect(screen.queryByLabelText("New API key")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(KEY);
  });

  it("shows a field error for an invalid name and does not reveal anything", async () => {
    mocks.createApiKeyAction.mockResolvedValue({ status: "error", message: "Enter a name for this key.", fieldErrors: { name: "Enter a name for this key." } });
    render(<ApiKeyManager projectId={PROJECT} initialKeys={[]} />);
    await userEvent.click(screen.getByRole("button", { name: "Create API key" }));
    expect(await screen.findByText("Enter a name for this key.")).toBeInTheDocument();
    expect(screen.getByLabelText("New key name")).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByLabelText("New API key")).not.toBeInTheDocument();
  });

  it("surfaces non-field errors such as the key limit", async () => {
    mocks.createApiKeyAction.mockResolvedValue({ status: "error", message: "A project can have at most 10 active keys. Revoke one first." });
    render(<ApiKeyManager projectId={PROJECT} initialKeys={[]} />);
    await userEvent.click(screen.getByRole("button", { name: "Create API key" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("at most 10 active keys");
  });

  it("asks for confirmation before revoking, then marks the key revoked", async () => {
    mocks.revokeApiKeyAction.mockResolvedValue({ status: "success", revokedAt: "2026-10-29T11:00:00Z" });
    render(<ApiKeyManager projectId={PROJECT} initialKeys={[record()]} />);

    await userEvent.click(screen.getByRole("button", { name: "Revoke key Production server" }));
    const dialog = await screen.findByRole("dialog", { name: "Revoke this key?" });
    expect(mocks.revokeApiKeyAction).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke key" }));
    expect(mocks.revokeApiKeyAction).toHaveBeenCalledWith({ keyId: record().id });
    expect(await screen.findByText("Revoked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Revoke key Production/ })).not.toBeInTheDocument();
  });

  it("can cancel a revoke", async () => {
    render(<ApiKeyManager projectId={PROJECT} initialKeys={[record()]} />);
    await userEvent.click(screen.getByRole("button", { name: "Revoke key Production server" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(mocks.revokeApiKeyAction).not.toHaveBeenCalled();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("does not offer revoke for an already revoked key", () => {
    render(<ApiKeyManager projectId={PROJECT} initialKeys={[record({ revoked_at: "2026-10-28T00:00:00Z" })]} />);
    expect(screen.getByText("Revoked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Revoke key/ })).not.toBeInTheDocument();
  });
});

describe("TestEventPanel", () => {
  beforeEach(() => mocks.sendTestEventAction.mockReset());
  const projects = [{ id: PROJECT, name: "checkout-web", environment: "production" }];

  it("sends through the action and reports the incident's occurrence count", async () => {
    mocks.sendTestEventAction.mockResolvedValue({ ok: true, created: true, incidentId: "inc-1", occurrenceCount: 3 });
    render(<TestEventPanel projects={projects} />);
    await userEvent.click(screen.getByRole("button", { name: "Send test event" }));
    expect(mocks.sendTestEventAction).toHaveBeenCalledWith({ projectId: PROJECT });
    expect(await screen.findByRole("status")).toHaveTextContent("accepted by the ingestion API");
    expect(screen.getByRole("status")).toHaveTextContent("3 occurrences");
  });

  it("shows failures as alerts", async () => {
    mocks.sendTestEventAction.mockResolvedValue({ ok: false, message: "Could not reach the ingestion API." });
    render(<TestEventPanel projects={projects} />);
    await userEvent.click(screen.getByRole("button", { name: "Send test event" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the ingestion API.");
  });

  it("lets the user pick between several projects", async () => {
    mocks.sendTestEventAction.mockResolvedValue({ ok: true, created: true, incidentId: "i", occurrenceCount: 1 });
    const two = [...projects, { id: "33333333-3333-4333-8333-333333333333", name: "api", environment: "staging" }];
    render(<TestEventPanel projects={two} />);
    await userEvent.selectOptions(screen.getByLabelText("Project"), "api (staging)");
    await userEvent.click(screen.getByRole("button", { name: "Send test event" }));
    expect(mocks.sendTestEventAction).toHaveBeenCalledWith({ projectId: "33333333-3333-4333-8333-333333333333" });
  });

  it("explains when there is no project", () => {
    render(<TestEventPanel projects={[]} />);
    expect(screen.getByText(/Create a project first/)).toBeInTheDocument();
  });
});
