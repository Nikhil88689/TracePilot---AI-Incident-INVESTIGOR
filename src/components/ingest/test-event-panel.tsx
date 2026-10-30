"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, Loader2, Send, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { sendTestEventAction } from "@/lib/ingest/test-event-action";
import type { TestEventResult } from "@/lib/ingest/test-event";

type Props = {
  projects: { id: string; name: string; environment: string }[];
  /** Unique per instance so two panels on one page don't share a label id. */
  idPrefix?: string;
};

/** Sends a real event through POST /api/v1/events (via a server action that mints a short-lived key). */
export function TestEventPanel({ projects, idPrefix = "test-event" }: Props) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [result, setResult] = useState<TestEventResult | null>(null);
  const [pending, startTransition] = useTransition();

  function send() {
    setResult(null);
    startTransition(async () => setResult(await sendTestEventAction({ projectId })));
  }

  if (projects.length === 0) {
    return <p className="text-sm text-muted-foreground">Create a project first to send a test event.</p>;
  }

  return (
    <div className="space-y-3">
      {projects.length > 1 ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-project`}>Project</Label>
          <NativeSelect id={`${idPrefix}-project`} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.environment})
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : null}

      <Button onClick={send} disabled={pending}>
        {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
        {pending ? "Sending…" : "Send test event"}
      </Button>

      <div aria-live="polite">
        {result?.ok ? (
          <p role="status" className="flex items-start gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              {result.created ? "Event accepted by the ingestion API." : "That event was already recorded."} Its incident
              now has{" "}
              <strong className="tabular-nums">{result.occurrenceCount}</strong>{" "}
              {result.occurrenceCount === 1 ? "occurrence" : "occurrences"}. Send again to watch the count grow.
            </span>
          </p>
        ) : null}
        {result && !result.ok ? (
          <p role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {result.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}
