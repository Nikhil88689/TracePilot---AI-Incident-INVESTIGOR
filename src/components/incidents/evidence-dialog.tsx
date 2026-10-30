"use client";

import { useEffect, useState } from "react";
import { Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { EventDetailPanel } from "@/components/events/event-detail-panel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { EventDetail } from "@/lib/incidents/types";

/** Loads one event's full detail. Returns null when it no longer exists or is not accessible. */
export type EventLoader = (eventId: string) => Promise<EventDetail | null>;

type Result = { state: "loading" } | { state: "ready"; event: EventDetail } | { state: "missing" } | { state: "error" };

/** Loads on mount; the parent re-mounts it (via `key`) per event, so no state needs resetting. */
function EvidenceBody({ eventId, loader }: { eventId: string; loader: EventLoader }) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    loader(eventId)
      .then((event) => !cancelled && setResult(event ? { state: "ready", event } : { state: "missing" }))
      .catch(() => !cancelled && setResult({ state: "error" }));
    return () => {
      cancelled = true;
    };
  }, [eventId, loader, attempt]);

  if (result.state === "loading") {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading event…
      </p>
    );
  }
  if (result.state === "missing") {
    return <p role="alert" className="text-sm text-muted-foreground">This event is no longer available. It may have been removed, or you may not have access to it.</p>;
  }
  if (result.state === "error") {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
        <TriangleAlert className="size-4" aria-hidden /> Could not load the event.
        <Button size="sm" variant="outline" onClick={() => { setResult({ state: "loading" }); setAttempt((n) => n + 1); }}>
          <RotateCcw aria-hidden /> Retry
        </Button>
      </div>
    );
  }
  return <EventDetailPanel event={result.event} showIncident={false} />;
}

type Props = { eventId: string | null; onClose: () => void; loader: EventLoader };

/** The "evidence panel": the actual stored event behind an AI citation. */
export function EvidenceDialog({ eventId, onClose, loader }: Props) {
  return (
    <Dialog open={eventId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Evidence event</DialogTitle>
          <DialogDescription>This is the event as stored by TracePilot, not the AI&apos;s description of it.</DialogDescription>
        </DialogHeader>
        {eventId ? <EvidenceBody key={eventId} eventId={eventId} loader={loader} /> : null}
      </DialogContent>
    </Dialog>
  );
}
