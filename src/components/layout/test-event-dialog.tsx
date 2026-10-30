"use client";

import { TestEventPanel } from "@/components/ingest/test-event-panel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useShell } from "./shell-context";

export function TestEventDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { projects } = useShell();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send test event</DialogTitle>
          <DialogDescription>
            Submits a sample error through the real ingestion API (<span className="font-mono">POST /api/v1/events</span>).
            Repeated sends group into one incident.
          </DialogDescription>
        </DialogHeader>

        <TestEventPanel projects={projects} idPrefix="dialog-test-event" />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
