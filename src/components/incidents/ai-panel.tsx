"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { BookOpen, Info, Loader2, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { loadSampleEvent, SAMPLE_ANALYSIS } from "@/lib/ai/sample";
import { loadEventDetailAction, toggleStepAction } from "@/lib/incidents/actions";
import type { Analysis } from "@/lib/incidents/types";
import { cn } from "@/lib/utils";
import { AnalysisView } from "./analysis-view";
import type { EventLoader } from "./evidence-dialog";

type Props = { incidentId: string; analysis: Analysis | null; configured: boolean };

type Notice = { tone: "error" | "info"; text: string; retryable?: boolean };

/** Client-side ceiling, a little above the server's own limit, so a hung connection can't spin forever. */
const CLIENT_TIMEOUT_MS = 70_000;

function progressMessage(seconds: number): string {
  if (seconds < 2) return "Collecting evidence from this incident's stored events…";
  if (seconds < 6) return "Sending a bounded selection of events to the model…";
  if (seconds < 40) return "Waiting for the model. This usually takes 10–30 seconds…";
  return "Still working. The request stops on its own if the provider takes too long…";
}

const isAnalysis = (value: unknown): value is Analysis =>
  typeof value === "object" && value !== null && "status" in value && "hypotheses" in value && "recommendedSteps" in value;

const loadLiveEvent: EventLoader = async (id) => {
  const result = await loadEventDetailAction({ eventId: id });
  return result.status === "ok" ? result.event : null;
};
const loadSample: EventLoader = async (id) => loadSampleEvent(id);

/**
 * Investigation panel. Calls POST /api/v1/incidents/[id]/analyze, which does the work inside one
 * bounded request; this component only starts it and reflects the saved result.
 */
export function AiPanel({ incidentId, analysis: initial, configured }: Props) {
  const router = useRouter();
  const [analysis, setAnalysis] = useState<Analysis | null>(initial);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sampleOpen, setSampleOpen] = useState(false);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setElapsed((s) => s + 1), 1_000);
    return () => clearInterval(timer);
  }, [running]);

  async function investigate() {
    if (running) return; // safe against double clicks before React re-renders
    setNotice(null);
    setElapsed(0);
    setRunning(true);
    // A successful run already put the saved analysis on screen. Refreshing then would re-key (remount) this panel and
    // close an evidence dialog the user just opened, so only refresh to pick up server state after a failure or timeout.
    let needsRefresh = true;
    try {
      const response = await fetch(`/api/v1/incidents/${incidentId}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        credentials: "same-origin",
        signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
      });
      const body: unknown = await response.json().catch(() => null);
      const data = (body ?? {}) as { analysis?: unknown; error?: { message?: string; retryable?: boolean; code?: string } };

      if (isAnalysis(data.analysis)) setAnalysis(data.analysis);
      if (response.ok && isAnalysis(data.analysis)) needsRefresh = false;
      if (!response.ok) {
        setNotice({
          tone: response.status === 409 ? "info" : "error",
          text: data.error?.message ?? "The analysis could not be completed.",
          retryable: data.error?.retryable ?? false,
        });
      }
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      setNotice({
        tone: "error",
        text: timedOut ? "The request took too long. It may still finish: refresh in a moment to see the saved result." : "Could not reach the server. Check your connection and try again.",
        retryable: true,
      });
    } finally {
      setRunning(false);
      if (needsRefresh) router.refresh();
    }
  }

  const onStepChange = useCallback(
    async (index: number, done: boolean) => {
      if (!analysis) return null;
      const result = await toggleStepAction({ analysisId: analysis.id, index, done });
      return result.status === "ok" ? result.completedSteps : null;
    },
    [analysis],
  );

  const pending = analysis?.status === "pending";
  const failed = analysis?.status === "failed";
  const complete = analysis?.status === "complete";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Sparkles className="size-4 text-primary" aria-hidden /> AI investigation
        </CardTitle>
        <CardDescription>Hypotheses drawn only from this incident&apos;s stored events. Not verified facts.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!configured ? (
          <p className="flex items-start gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              AI analysis is not configured on this deployment. Set <code className="font-mono text-foreground">ANTHROPIC_API_KEY</code> to enable it. You can still view a labelled sample.
            </span>
          </p>
        ) : null}

        {running ? (
          <div role="status" aria-live="polite" className="space-y-1 rounded-md border border-border bg-muted/40 px-3 py-2">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Investigating…
            </p>
            <p className="text-xs text-muted-foreground">{progressMessage(elapsed)}</p>
            <p className="text-xs tabular-nums text-muted-foreground">{elapsed}s elapsed</p>
          </div>
        ) : null}

        {pending && !running ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden /> An analysis is in progress. It stops on its own if it takes too long.
          </p>
        ) : null}

        {failed && !running ? (
          <div role="alert" className="space-y-1 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <p className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {analysis?.errorMessage ?? "The last analysis failed."}
            </p>
            <p className="pl-6 text-xs">{analysis?.retryable ? "This may be temporary. You can try again." : "Trying again won't help until this is fixed."}</p>
          </div>
        ) : null}

        {notice && !(failed && notice.text === analysis?.errorMessage) ? (
          <p role={notice.tone === "error" ? "alert" : "status"} className={cn("text-sm", notice.tone === "error" ? "text-destructive" : "text-muted-foreground")}>
            {notice.text}
            {notice.retryable && notice.tone === "error" ? " You can try again." : ""}
          </p>
        ) : null}

        {complete && analysis ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Last saved analysis ·{" "}
              <time dateTime={analysis.completedAt ?? analysis.createdAt}>{new Date(analysis.completedAt ?? analysis.createdAt).toISOString().replace("T", " ").slice(0, 16)} UTC</time>
            </p>
            <AnalysisView key={analysis.id} analysis={analysis} loader={loadLiveEvent} onStepChange={onStepChange} />
          </div>
        ) : null}

        {!analysis && !running && configured ? (
          <p className="text-sm text-muted-foreground">No analysis yet. Investigating sends a bounded selection of this incident&apos;s stored events to the configured AI model.</p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button size="lg" className="w-full sm:w-auto" onClick={() => void investigate()} disabled={!configured || running || pending} variant={complete ? "outline" : "default"}>
            {running ? <Loader2 className="animate-spin" aria-hidden /> : complete ? <RefreshCw aria-hidden /> : <Sparkles aria-hidden />}
            {running ? "Investigating…" : complete ? "Re-run investigation" : failed ? "Try again" : "Investigate with AI"}
          </Button>
          {pending && !running ? (
            <Button variant="outline" size="lg" onClick={() => router.refresh()}>
              <RefreshCw aria-hidden /> Refresh
            </Button>
          ) : null}
        </div>

        <button type="button" onClick={() => setSampleOpen(true)} className="flex items-center gap-1.5 rounded-sm text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          <BookOpen className="size-3.5" aria-hidden /> View a sample investigation
        </button>

        <Dialog open={sampleOpen} onOpenChange={setSampleOpen}>
          <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Sample investigation</DialogTitle>
              <DialogDescription>What a finished investigation looks like. Fictional data; not a diagnosis of your incident.</DialogDescription>
            </DialogHeader>
            <AnalysisView analysis={SAMPLE_ANALYSIS} loader={loadSample} />
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
