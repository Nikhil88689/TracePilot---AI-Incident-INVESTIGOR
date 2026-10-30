import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateProjectState, Project } from "@/lib/projects/schemas";

const createProjectAction = vi.hoisted(() => vi.fn());
vi.mock("@/lib/projects/actions", () => ({ createProjectAction }));
vi.mock("@/lib/ingest/key-actions", () => ({ createApiKeyAction: vi.fn(), revokeApiKeyAction: vi.fn() }));
vi.mock("@/lib/ingest/test-event-action", () => ({ sendTestEventAction: vi.fn() }));

import { OnboardingWizard } from "./onboarding-wizard";

const ENDPOINT = "https://app.example.com/api/v1/events";
const project: Project = {
  id: "p1",
  name: "checkout-web",
  environment: "staging",
  created_at: "2026-10-29T00:00:00Z",
};
const success: CreateProjectState = { status: "success", project };

async function fillNameAndContinue(name = "checkout-web") {
  await userEvent.type(screen.getByLabelText("Project name"), name);
  await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
}

describe("OnboardingWizard", () => {
  beforeEach(() => createProjectAction.mockReset());

  it("starts at step 1 and blocks an empty name", async () => {
    render(<OnboardingWizard initialProject={null} endpoint={ENDPOINT} />);
    expect(screen.getByRole("heading", { name: "Create your first project" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a project name");
    expect(screen.getByRole("heading", { name: "Create your first project" })).toBeInTheDocument();
    expect(createProjectAction).not.toHaveBeenCalled();
  });

  it("walks through all four steps, creating the project once", async () => {
    createProjectAction.mockResolvedValue(success);
    render(<OnboardingWizard initialProject={null} endpoint={ENDPOINT} />);

    await fillNameAndContinue();
    expect(screen.getByRole("heading", { name: "Choose an environment" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: /Staging/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Create project" }));

    expect(createProjectAction).toHaveBeenCalledTimes(1);
    expect(createProjectAction).toHaveBeenCalledWith({
      name: "checkout-web",
      environment: "staging",
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });

    expect(await screen.findByRole("heading", { name: "Send events from your app" })).toBeInTheDocument();
    expect(screen.getByLabelText("2. Ingestion endpoint")).toHaveValue(ENDPOINT);
    expect(screen.getByRole("button", { name: "Create API key" })).toBeInTheDocument();
    expect(screen.getByLabelText("SDK usage example")).toHaveTextContent("@tracepilot/node");
    expect(screen.getByLabelText("SDK usage example")).toHaveTextContent(ENDPOINT);
    expect(screen.getByLabelText("curl example")).toHaveTextContent("TRACEPILOT_API_KEY");

    await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(screen.getByRole("heading", { name: "You're all set" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open incidents" })).toHaveAttribute("href", "/incidents");
    expect(screen.getByRole("button", { name: "Send test event" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Go to dashboard/ })).toHaveAttribute("href", "/dashboard");
  });

  it("lets the user go back, and locks the already-created project instead of creating another", async () => {
    createProjectAction.mockResolvedValue(success);
    render(<OnboardingWizard initialProject={null} endpoint={ENDPOINT} />);
    await fillNameAndContinue();
    await userEvent.click(await screen.findByRole("button", { name: "Create project" }));
    await screen.findByRole("heading", { name: "Send events from your app" });

    await userEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(screen.getByRole("heading", { name: "Choose an environment" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Production/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Create project" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(screen.getByLabelText("Project name")).toBeDisabled();
    expect(createProjectAction).toHaveBeenCalledTimes(1);
  });

  it("reuses the same request id when a failed create is retried", async () => {
    createProjectAction
      .mockResolvedValueOnce({ status: "error", message: "We could not create the project. Please try again." })
      .mockResolvedValueOnce(success);
    render(<OnboardingWizard initialProject={null} endpoint={ENDPOINT} />);
    await fillNameAndContinue();

    await userEvent.click(await screen.findByRole("button", { name: "Create project" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not create");
    await userEvent.click(await screen.findByRole("button", { name: "Create project" }));
    await screen.findByRole("heading", { name: "Send events from your app" });

    const [first, second] = createProjectAction.mock.calls.map((c) => c[0].requestId);
    expect(first).toBe(second);
  });

  it("returns to step 1 with the message when the name is already taken", async () => {
    createProjectAction.mockResolvedValue({
      status: "error",
      message: "You already have a project with that name.",
      fieldErrors: { name: "You already have a project with that name." },
    });
    render(<OnboardingWizard initialProject={null} endpoint={ENDPOINT} />);
    await fillNameAndContinue();
    await userEvent.click(await screen.findByRole("button", { name: "Create project" }));

    expect(await screen.findByRole("heading", { name: "Create your first project" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("already have a project");
    expect(screen.getByLabelText("Project name")).toHaveAttribute("aria-invalid", "true");
  });

  it("resumes at the install step for a user who already has a project", () => {
    render(<OnboardingWizard initialProject={project} endpoint={ENDPOINT} />);
    expect(screen.getByRole("heading", { name: "Send events from your app" })).toBeInTheDocument();
    expect(createProjectAction).not.toHaveBeenCalled();
  });

  it("marks the current step in the progress indicator", () => {
    render(<OnboardingWizard initialProject={null} endpoint={ENDPOINT} />);
    const nav = screen.getByRole("navigation", { name: "Onboarding progress" });
    expect(nav.querySelector('[aria-current="step"]')).toHaveTextContent("Project");
  });
});
