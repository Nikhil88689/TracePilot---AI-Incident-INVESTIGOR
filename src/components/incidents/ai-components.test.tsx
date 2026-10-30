import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_ANALYSIS, SAMPLE_EVENTS } from "@/lib/ai/sample";
import type { Analysis, EventDetail } from "@/lib/incidents/types";

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: nav.refresh, push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/incidents/x",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const actions = vi.hoisted(() => ({ toggleStepAction: vi.fn(), loadEventDetailAction: vi.fn() }));
vi.mock("@/lib/incidents/actions", () => actions);

import { AiPanel } from "./ai-panel";
import { AnalysisView } from "./analysis-view";
import { EvidenceDialog } from "./evidence-dialog";

const INCIDENT = "11111111-1111-4111-8111-111111111111";
const E1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const E2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const analysis = (over: Partial<Analysis> = {}): Analysis => ({
  id: "an1", status: "complete", summary: "Cart items are read before they load.",
  hypotheses: [
    { title: "Items undefined on first render", explanation: "Both events read a property of undefined.", confidence: "high",
      evidence: [{ eventId: E1, occurredAt: "2026-10-30T10:00:00Z", message: "Cannot read items", why: "It reads 'items' on an undefined cart." }, { eventId: E2, occurredAt: "2026-10-30T11:00:00Z", message: "Cannot read name", why: "Same failure, different property." }] },
    { title: "A recent release introduced it", explanation: "All events share a release.", confidence: "low", evidence: [{ eventId: E2, occurredAt: "2026-10-30T11:00:00Z", message: "Cannot read name", why: "Latest event, same release." }] },
  ],
  recommendedSteps: [{ step: "Read addItem in cart.ts", rationale: "Stack frame points there." }, { step: "Compare the last two releases", rationale: null }],
  missingInformation: ["Events before the release"], limitations: ["Only 2 of 40 events were shown"], completedSteps: [], inputEventCount: 2,
  model: "claude-sonnet-5-5", usage: { inputTokens: 1200, outputTokens: 800 }, errorMessage: null, errorCode: null, retryable: false,
  createdAt: "2026-10-30T12:00:00Z", completedAt: "2026-10-30T12:00:20Z", ...over,
});

const eventDetail = (id: string, over: Partial<EventDetail> = {}): EventDetail => ({
  id, projectId: "p", projectName: "web", externalEventId: `ext-${id.slice(0, 4)}`, eventType: "TypeError", level: "error", message: "Cannot read items",
  endpoint: "/api/cart", occurredAt: "2026-10-30T10:00:00Z", incidentId: INCIDENT, incidentTitle: "T", stackTrace: "TypeError: x\n    at addItem (/app/cart.ts:1:1)", attributes: { release: "1.2.3" }, ...over,
});

const okResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchMock = vi.fn();

beforeEach(() => {
  nav.refresh.mockClear();
  actions.toggleStepAction.mockReset();
  actions.loadEventDetailAction.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AiPanel: starting an investigation", () => {
  it("says clearly that credentials are missing, disables the live action, but still offers the sample", () => {
    render(<AiPanel incidentId={INCIDENT} analysis={null} configured={false} />);
    expect(screen.getByText(/not configured on this deployment/)).toHaveTextContent("ANTHROPIC_API_KEY");
    expect(screen.getByRole("button", { name: "Investigate with AI" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /View a sample investigation/ })).toBeEnabled();
  });

  it("POSTs to the real endpoint as JSON and then shows the summary before the hypotheses", async () => {
    fetchMock.mockResolvedValue(okResponse({ analysis: analysis() }));
    render(<AiPanel incidentId={INCIDENT} analysis={null} configured />);
    expect(screen.getByText(/No analysis yet/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Investigate with AI" }));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/v1/incidents/${INCIDENT}/analyze`);
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

    expect(await screen.findByText("Cart items are read before they load.")).toBeInTheDocument();
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent ?? "");
    expect(headings.findIndex((h) => h.startsWith("Summary"))).toBeLessThan(headings.findIndex((h) => h === "Ranked hypotheses"));
    expect(nav.refresh).not.toHaveBeenCalled(); // the saved analysis is already on screen; a refresh would remount the panel and close open dialogs
    expect(screen.getByRole("button", { name: "Re-run investigation" })).toBeEnabled();
  });

  it("shows a clear loading state with staged progress messages and elapsed time", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let finish: (r: Response) => void = () => {};
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (finish = resolve)));
    render(<AiPanel incidentId={INCIDENT} analysis={null} configured />);
    await userEvent.click(screen.getByRole("button", { name: "Investigate with AI" }));

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Investigating…");
    expect(status).toHaveTextContent("Collecting evidence");
    expect(screen.getByRole("button", { name: "Investigating…" })).toBeDisabled();

    act(() => void vi.advanceTimersByTime(3_000));
    expect(screen.getByRole("status")).toHaveTextContent("Sending a bounded selection of events");
    act(() => void vi.advanceTimersByTime(5_000));
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for the model");
    expect(screen.getByRole("status")).toHaveTextContent("8s elapsed");
    act(() => void vi.advanceTimersByTime(40_000));
    expect(screen.getByRole("status")).toHaveTextContent("stops on its own");

    await act(async () => finish(okResponse({ analysis: analysis() })));
    await screen.findByText("Cart items are read before they load.");
    expect(screen.queryByText(/elapsed/)).not.toBeInTheDocument();
  });

  it("prevents accidental repeated submissions", async () => {
    let finish: (r: Response) => void = () => {};
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (finish = resolve)));
    render(<AiPanel incidentId={INCIDENT} analysis={null} configured />);
    const button = screen.getByRole("button", { name: "Investigate with AI" });
    await userEvent.dblClick(button);
    await userEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => finish(okResponse({ analysis: analysis() })));
  });
});

describe("AiPanel: failures are explained and recoverable", () => {
  const failedAnalysis = (over: Partial<Analysis> = {}) => analysis({ status: "failed", summary: null, hypotheses: [], recommendedSteps: [], errorMessage: "The AI provider took too long to respond. Try again.", errorCode: "timeout", retryable: true, ...over });

  it("shows a retryable failure returned with the saved failed analysis, and offers Try again", async () => {
    fetchMock.mockResolvedValue(okResponse({ error: { code: "timeout", message: "The AI provider took too long to respond. Try again.", retryable: true }, analysis: failedAnalysis() }, 504));
    render(<AiPanel incidentId={INCIDENT} analysis={null} configured />);
    await userEvent.click(screen.getByRole("button", { name: "Investigate with AI" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("took too long");
    expect(alert).toHaveTextContent("This may be temporary. You can try again.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("explains that a non-retryable failure needs a fix first", () => {
    render(<AiPanel incidentId={INCIDENT} analysis={failedAnalysis({ errorMessage: "The AI provider rejected the configured API key. Check ANTHROPIC_API_KEY.", errorCode: "auth", retryable: false })} configured />);
    expect(screen.getByRole("alert")).toHaveTextContent("rejected the configured API key");
    expect(screen.getByRole("alert")).toHaveTextContent("Trying again won't help until this is fixed");
  });

  it.each([
    [429, "analysis_rate_limited", "Too many analyses started recently. Try again later."],
    [503, "ai_not_configured", "AI analysis is not configured on this server."],
    [401, "unauthorized", "Sign in to run an investigation."],
  ])("shows the server's message for HTTP %i", async (status, code, message) => {
    fetchMock.mockResolvedValue(okResponse({ error: { code, message, retryable: status === 429 } }, status));
    render(<AiPanel incidentId={INCIDENT} analysis={null} configured />);
    await userEvent.click(screen.getByRole("button", { name: "Investigate with AI" }));
    expect(await screen.findByText(new RegExp(message.slice(0, 20)))).toBeInTheDocument();
  });

  it("treats 'already running' (409) as information, not an error", async () => {
    fetchMock.mockResolvedValue(okResponse({ error: { code: "analysis_in_progress", message: "An analysis is already running for this incident.", retryable: true } }, 409));
    render(<AiPanel incidentId={INCIDENT} analysis={null} configured />);
    await userEvent.click(screen.getByRole("button", { name: "Investigate with AI" }));
    expect(await screen.findByText("An analysis is already running for this incident.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("handles a network failure and a client-side timeout, and the button works again afterwards", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    render(<AiPanel incidentId={INCIDENT} analysis={null} configured />);
    await userEvent.click(screen.getByRole("button", { name: "Investigate with AI" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the server");
    expect(screen.getByRole("button", { name: "Investigate with AI" })).toBeEnabled();

    fetchMock.mockRejectedValueOnce(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    await userEvent.click(screen.getByRole("button", { name: "Investigate with AI" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("took too long"));
    expect(screen.getByRole("alert")).toHaveTextContent("refresh in a moment");
  });

  it("copes with a non-JSON error body", async () => {
    fetchMock.mockResolvedValue(new Response("<html>Bad gateway</html>", { status: 502 }));
    render(<AiPanel incidentId={INCIDENT} analysis={null} configured />);
    await userEvent.click(screen.getByRole("button", { name: "Investigate with AI" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be completed");
  });

  it("shows an analysis that is still in progress, blocks a second run, and can refresh", async () => {
    render(<AiPanel incidentId={INCIDENT} analysis={analysis({ status: "pending", summary: null, hypotheses: [] })} configured />);
    expect(screen.getByRole("status")).toHaveTextContent("in progress");
    expect(screen.getByRole("button", { name: "Investigate with AI" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(nav.refresh).toHaveBeenCalled();
  });
});

describe("AiPanel: last saved analysis and re-running", () => {
  it("shows the last saved analysis on load, labelled as such, without calling the provider", () => {
    render(<AiPanel incidentId={INCIDENT} analysis={analysis()} configured />);
    expect(screen.getByText(/Last saved analysis/)).toBeInTheDocument();
    expect(screen.getByText("Cart items are read before they load.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-runs and replaces the displayed analysis", async () => {
    fetchMock.mockResolvedValue(okResponse({ analysis: analysis({ id: "an2", summary: "A newer summary." }) }));
    render(<AiPanel incidentId={INCIDENT} analysis={analysis()} configured />);
    await userEvent.click(screen.getByRole("button", { name: "Re-run investigation" }));
    expect(await screen.findByText("A newer summary.")).toBeInTheDocument();
    expect(screen.queryByText("Cart items are read before they load.")).not.toBeInTheDocument();
  });

  it("persists checklist ticks through the server action", async () => {
    actions.toggleStepAction.mockResolvedValue({ status: "ok", completedSteps: [1] });
    render(<AiPanel incidentId={INCIDENT} analysis={analysis()} configured />);
    await userEvent.click(screen.getByRole("checkbox", { name: /Compare the last two releases/ }));
    expect(actions.toggleStepAction).toHaveBeenCalledWith({ analysisId: "an1", index: 1, done: true });
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Compare the last two releases/ })).toBeChecked());
  });
});

describe("AiPanel: sample investigation", () => {
  it("opens a clearly labelled sample that needs no AI, and its evidence opens without any server call", async () => {
    render(<AiPanel incidentId={INCIDENT} analysis={null} configured={false} />);
    await userEvent.click(screen.getByRole("button", { name: /View a sample investigation/ }));
    const dialog = await screen.findByRole("dialog", { name: "Sample investigation" });
    expect(within(dialog).getByRole("note")).toHaveTextContent("SAMPLE");
    expect(within(dialog).getByRole("note")).toHaveTextContent("No AI model was called");
    expect(within(dialog).getByText(/Sample analysis on/)).toBeInTheDocument();

    const first = SAMPLE_EVENTS[0];
    await userEvent.click(within(dialog).getAllByRole("button", { name: new RegExp(`Open evidence event ${first.id.slice(0, 8)}`) })[0]);
    const evidence = await screen.findByRole("dialog", { name: "Evidence event" });
    expect(await within(evidence).findByText(first.externalEventId)).toBeInTheDocument();
    expect(actions.loadEventDetailAction).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("AnalysisView", () => {
  const loader = vi.fn(async (id: string) => eventDetail(id));
  beforeEach(() => {
    loader.mockClear();
  });

  it("labels everything the model wrote as AI-generated and not verified", () => {
    render(<AnalysisView analysis={analysis()} loader={loader} />);
    expect(screen.getByRole("note")).toHaveTextContent("AI-generated, not verified");
    expect(screen.getByRole("note")).toHaveTextContent("did not run code, reproduce the problem, or verify a cause");
    expect(screen.getByText(/\(AI-generated\)/)).toBeInTheDocument();
    expect(screen.getByText(/AI output can be wrong/)).toBeInTheDocument();
  });

  it("ranks hypotheses and labels confidence as the model's estimate, not a probability", () => {
    render(<AnalysisView analysis={analysis()} loader={loader} />);
    const list = within(screen.getByRole("list", { name: "Ranked hypotheses" }));
    const cards = list.getAllByRole("listitem", { name: "" }).filter((li) => li.textContent?.includes("Hypothesis #"));
    expect(cards[0]).toHaveTextContent("Hypothesis #1");
    expect(cards[0]).toHaveTextContent("Items undefined on first render");
    expect(cards[1]).toHaveTextContent("Hypothesis #2");
    expect(screen.getByText("Model-reported confidence: High")).toBeInTheDocument();
    expect(screen.getByText("Model-reported confidence: Low")).toBeInTheDocument();
    expect(screen.getByText(/not calibrated probabilities/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\d+\s?%\s*(confidence|likely|probab)/i);
  });

  it("opens the real stored event when an evidence reference is clicked", async () => {
    render(<AnalysisView analysis={analysis()} loader={loader} />);
    const first = screen.getByRole("list", { name: "Evidence for hypothesis 1" });
    await userEvent.click(within(first).getAllByRole("button")[0]);
    const dialog = await screen.findByRole("dialog", { name: "Evidence event" });
    expect(loader).toHaveBeenCalledWith(E1);
    expect(await within(dialog).findByText(`ext-${E1.slice(0, 4)}`)).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Event attributes")).toHaveTextContent("1.2.3");
    expect(within(dialog).getByText(/as stored by TracePilot, not the AI's description/)).toBeInTheDocument();
  });

  it("says so when an evidence event is no longer available, and lets the user retry a load error", async () => {
    const missing = vi.fn(async () => null);
    const { unmount } = render(<AnalysisView analysis={analysis()} loader={missing} />);
    await userEvent.click(within(screen.getByRole("list", { name: "Evidence for hypothesis 1" })).getAllByRole("button")[0]);
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer available");
    unmount();

    const flaky = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(eventDetail(E1));
    render(<AnalysisView analysis={analysis()} loader={flaky} />);
    await userEvent.click(within(screen.getByRole("list", { name: "Evidence for hypothesis 1" })).getAllByRole("button")[0]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the event");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(`ext-${E1.slice(0, 4)}`)).toBeInTheDocument();
  });

  it("has an expandable 'Why this hypothesis?' with the per-event reasoning", async () => {
    render(<AnalysisView analysis={analysis()} loader={loader} />);
    const toggle = screen.getAllByRole("button", { name: "Why this hypothesis?" })[0];
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("It reads 'items' on an undefined cart.")).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("It reads 'items' on an undefined cart.")).toBeInTheDocument();
    expect(screen.getByText("Same failure, different property.")).toBeInTheDocument();
    expect(screen.getByText(/the model's reasoning, not a verified fact/)).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(screen.queryByText("It reads 'items' on an undefined cart.")).not.toBeInTheDocument();
  });

  it("shows recommended steps as a checklist the developer can tick, with a running count", async () => {
    const onStepChange = vi.fn(async (_i: number, done: boolean) => (done ? [0] : []));
    render(<AnalysisView analysis={analysis()} loader={loader} onStepChange={onStepChange} />);
    expect(screen.getByText("0 of 2 checked")).toBeInTheDocument();
    expect(screen.getByText(/Nothing here has been run, and TracePilot will never run it for you/)).toBeInTheDocument();
    const box = screen.getByRole("checkbox", { name: /Read addItem in cart.ts/ });
    await userEvent.click(box);
    expect(onStepChange).toHaveBeenCalledWith(0, true);
    await waitFor(() => expect(screen.getByText("1 of 2 checked")).toBeInTheDocument());
    expect(box).toBeChecked();
    await userEvent.click(box);
    await waitFor(() => expect(box).not.toBeChecked());
  });

  it("starts with previously saved ticks", () => {
    render(<AnalysisView analysis={analysis({ completedSteps: [1] })} loader={loader} />);
    expect(screen.getByRole("checkbox", { name: /Compare the last two releases/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Read addItem/ })).not.toBeChecked();
  });

  it("rolls a tick back and says so when saving fails", async () => {
    render(<AnalysisView analysis={analysis()} loader={loader} onStepChange={async () => null} />);
    const box = screen.getByRole("checkbox", { name: /Read addItem in cart.ts/ });
    await userEvent.click(box);
    expect(await screen.findByRole("alert")).toHaveTextContent("It was not applied");
    expect(box).not.toBeChecked();
    expect(screen.getByText("0 of 2 checked")).toBeInTheDocument();
  });

  it("shows missing evidence and limitations, and omits empty sections", () => {
    const { rerender } = render(<AnalysisView analysis={analysis()} loader={loader} />);
    expect(screen.getByRole("heading", { name: "Missing evidence" })).toBeInTheDocument();
    expect(screen.getByText("Events before the release")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Limitations" })).toBeInTheDocument();
    expect(screen.getByText("Only 2 of 40 events were shown")).toBeInTheDocument();
    rerender(<AnalysisView analysis={analysis({ id: "an9", missingInformation: [], limitations: [] })} loader={loader} />);
    expect(screen.queryByRole("heading", { name: "Missing evidence" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Limitations" })).not.toBeInTheDocument();
  });

  it("shows the model, time, token usage and how many events were analysed", () => {
    render(<AnalysisView analysis={analysis()} loader={loader} />);
    expect(screen.getByText(/Generated by claude-sonnet-5-5/)).toHaveTextContent("1,200 input / 800 output tokens");
    expect(screen.getByRole("note")).toHaveTextContent("based on 2 stored event");
  });

  it("renders the sample with its own banner and no AI-generated-by claim", () => {
    render(<AnalysisView analysis={SAMPLE_ANALYSIS} loader={async (id) => SAMPLE_EVENTS.find((e) => e.id === id) ?? null} />);
    expect(screen.getByRole("note")).toHaveTextContent("SAMPLE");
    expect(screen.queryByText(/Generated by/)).not.toBeInTheDocument();
  });
});

describe("EvidenceDialog", () => {
  it("is closed without an event id and does not load anything", () => {
    const loader = vi.fn();
    render(<EvidenceDialog eventId={null} onClose={() => {}} loader={loader} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(loader).not.toHaveBeenCalled();
  });

  it("shows a loading state, then the event, and calls onClose when dismissed", async () => {
    let resolve: (e: EventDetail) => void = () => {};
    const loader = vi.fn(() => new Promise<EventDetail>((r) => (resolve = r)));
    const onClose = vi.fn();
    render(<EvidenceDialog eventId={E1} onClose={onClose} loader={loader} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Loading event");
    await act(async () => resolve(eventDetail(E1)));
    expect(await screen.findByText("/api/cart")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
