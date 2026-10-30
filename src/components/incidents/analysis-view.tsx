"use client";

import { useId, useState } from "react";
import { ChevronRight, FileSearch, ListChecks, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Analysis, AnalysisHypothesis } from "@/lib/incidents/types";
import { cn } from "@/lib/utils";
import { EvidenceDialog, type EventLoader } from "./evidence-dialog";

const CONFIDENCE = {
  high: { label: "High", style: "border-success/30 bg-success/10 text-success" },
  medium: { label: "Medium", style: "border-warning/30 bg-warning/10 text-warning" },
  low: { label: "Low", style: "border-border bg-muted text-muted-foreground" },
} as const;

const time = (iso: string) => new Date(iso).toISOString().slice(11, 19);

function HypothesisCard({ rank, hypothesis, onOpenEvidence }: { rank: number; hypothesis: AnalysisHypothesis; onOpenEvidence: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const confidence = CONFIDENCE[hypothesis.confidence];

  return (
    <li className="space-y-3 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">Hypothesis #{rank}</p>
          <h4 className="text-sm font-medium break-words">{hypothesis.title}</h4>
        </div>
        <Badge variant="outline" className={cn("shrink-0", confidence.style)}>
          Model-reported confidence: {confidence.label}
        </Badge>
      </div>

      <p className="text-sm text-muted-foreground">{hypothesis.explanation}</p>

      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">Supporting events ({hypothesis.evidence.length})</p>
        <ul className="flex flex-wrap gap-1.5" aria-label={`Evidence for hypothesis ${rank}`}>
          {hypothesis.evidence.map((e) => (
            <li key={e.eventId}>
              <Button
                variant="outline"
                size="xs"
                onClick={() => onOpenEvidence(e.eventId)}
                aria-label={`Open evidence event ${e.eventId.slice(0, 8)} from ${time(e.occurredAt)} UTC`}
                className="font-mono"
              >
                <FileSearch aria-hidden /> {e.eventId.slice(0, 8)} · {time(e.occurredAt)}
              </Button>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 rounded-sm text-xs font-medium text-primary hover:underline"
        >
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} aria-hidden />
          Why this hypothesis?
        </button>
        {open ? (
          <div id={panelId} className="mt-2 space-y-2 rounded-md bg-muted/40 p-3">
            <p className="text-xs text-muted-foreground">How the model says each event supports it (the model&apos;s reasoning, not a verified fact):</p>
            <ul className="space-y-2">
              {hypothesis.evidence.map((e) => (
                <li key={e.eventId} className="text-sm">
                  <p>{e.why}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    <button type="button" onClick={() => onOpenEvidence(e.eventId)} className="font-mono underline-offset-2 hover:underline">
                      {e.eventId.slice(0, 8)}
                    </button>{" "}
                    · {time(e.occurredAt)} UTC · <span className="break-words">{e.message}</span>
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </li>
  );
}

type Props = {
  analysis: Analysis;
  loader: EventLoader;
  /** Persist a checklist change. Resolve with the saved list, or null if it failed (the UI rolls back). */
  onStepChange?: (index: number, done: boolean) => Promise<number[] | null>;
};

/**
 * A completed analysis. Everything the model wrote is labelled as AI-generated; the only things
 * presented as fact are the stored events behind each citation, which open in the evidence panel.
 */
export function AnalysisView({ analysis, loader, onStepChange }: Props) {
  const [evidenceId, setEvidenceId] = useState<string | null>(null);
  const [completed, setCompleted] = useState<number[]>(analysis.completedSteps);
  const [stepError, setStepError] = useState<string>();

  async function toggle(index: number, done: boolean) {
    setStepError(undefined);
    const previous = completed;
    // Optimistic: tick immediately, roll back if the save fails.
    setCompleted(done ? [...new Set([...previous, index])].sort((a, b) => a - b) : previous.filter((i) => i !== index));
    if (!onStepChange) return; // read-only (sample)
    const saved = await onStepChange(index, done).catch(() => null);
    if (saved) setCompleted(saved);
    else {
      setCompleted(previous);
      setStepError("Couldn't save that change. It was not applied.");
    }
  }

  return (
    <div className="space-y-5">
      {analysis.simulated ? (
        <p role="note" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          <strong>SIMULATED.</strong> This analysis was written in advance for the demo scenario. No AI model was called and it describes fictional data. Use Re-run investigation to try a live one.
        </p>
      ) : analysis.sample ? (
        <p role="note" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          <strong>SAMPLE.</strong> This is a fixed, fictional example built from seeded sample logs. No AI model was called and it says nothing about your incidents.
        </p>
      ) : (
        <p role="note" className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            <strong className="text-foreground">AI-generated, not verified.</strong> These are hypotheses based on {analysis.inputEventCount ?? "a selection of"} stored event(s). TracePilot did not run code, reproduce the problem, or verify a cause.
          </span>
        </p>
      )}

      <section aria-labelledby={`${analysis.id}-summary`}>
        <h3 id={`${analysis.id}-summary`} className="mb-1 text-sm font-medium">
          Summary <span className="font-normal text-muted-foreground">(AI-generated)</span>
        </h3>
        <p className="text-sm leading-relaxed">{analysis.summary}</p>
      </section>

      <section aria-labelledby={`${analysis.id}-hyp`}>
        <h3 id={`${analysis.id}-hyp`} className="mb-1 text-sm font-medium">
          Ranked hypotheses
        </h3>
        <p className="mb-2 text-xs text-muted-foreground">
          Most likely first, as judged by the model. Confidence labels are the model&apos;s own rough estimates, not calibrated probabilities.
        </p>
        <ol className="space-y-3" aria-label="Ranked hypotheses">
          {analysis.hypotheses.map((h, i) => (
            <HypothesisCard key={i} rank={i + 1} hypothesis={h} onOpenEvidence={setEvidenceId} />
          ))}
        </ol>
      </section>

      <section aria-labelledby={`${analysis.id}-steps`}>
        <h3 id={`${analysis.id}-steps`} className="mb-1 flex items-center gap-1.5 text-sm font-medium">
          <ListChecks className="size-4" aria-hidden /> Suggested diagnostic steps
        </h3>
        <p className="mb-2 text-xs text-muted-foreground">Ideas for you to check. Nothing here has been run, and TracePilot will never run it for you.</p>
        <ul className="space-y-2">
          {analysis.recommendedSteps.map((s, i) => {
            const id = `${analysis.id}-step-${i}`;
            const done = completed.includes(i);
            return (
              <li key={i} className="flex items-start gap-2.5">
                <input
                  id={id}
                  type="checkbox"
                  checked={done}
                  onChange={(e) => void toggle(i, e.target.checked)}
                  className="mt-1 size-4 shrink-0 accent-[var(--primary)]"
                />
                <label htmlFor={id} className="min-w-0 cursor-pointer text-sm">
                  <span className={cn("break-words", done && "text-muted-foreground line-through")}>{s.step}</span>
                  {s.rationale ? <span className="block text-xs text-muted-foreground">{s.rationale}</span> : null}
                </label>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
          {completed.length} of {analysis.recommendedSteps.length} checked
        </p>
        {stepError ? (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {stepError}
          </p>
        ) : null}
      </section>

      {analysis.missingInformation.length > 0 ? (
        <section aria-labelledby={`${analysis.id}-missing`}>
          <h3 id={`${analysis.id}-missing`} className="mb-1 text-sm font-medium">
            Missing evidence
          </h3>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {analysis.missingInformation.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {analysis.limitations.length > 0 ? (
        <section aria-labelledby={`${analysis.id}-limits`}>
          <h3 id={`${analysis.id}-limits`} className="mb-1 text-sm font-medium">
            Limitations
          </h3>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {analysis.limitations.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="border-t border-border pt-3 text-xs text-muted-foreground">
        {analysis.sample ? "Sample analysis" : analysis.simulated ? "Simulated demo analysis (pre-written)" : `Generated by ${analysis.model ?? "an AI model"}`} on{" "}
        <time dateTime={analysis.completedAt ?? analysis.createdAt}>{new Date(analysis.completedAt ?? analysis.createdAt).toISOString().replace("T", " ").slice(0, 16)} UTC</time>
        {analysis.usage ? ` · ${analysis.usage.inputTokens.toLocaleString("en-US")} input / ${analysis.usage.outputTokens.toLocaleString("en-US")} output tokens` : ""}. AI output can be wrong; check it against the events.
      </p>

      <EvidenceDialog eventId={evidenceId} onClose={() => setEvidenceId(null)} loader={loader} />
    </div>
  );
}
