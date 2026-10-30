"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const SHORTCUTS: [keys: string, action: string][] = [
  ["Ctrl K", "Open search and commands"],
  ["Esc", "Close dialogs and menus"],
  ["← →", "Change time range when focused"],
];

export function HelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Documentation</DialogTitle>
          <DialogDescription>How TracePilot turns raw errors into incidents.</DialogDescription>
        </DialogHeader>

        <ol className="space-y-3 text-sm">
          <li>
            <p className="font-medium">1. Send events</p>
            <p className="text-muted-foreground">
              Your application posts error events to a project&apos;s ingestion endpoint using an API key.
            </p>
          </li>
          <li>
            <p className="font-medium">2. Review incidents</p>
            <p className="text-muted-foreground">
              Related events are fingerprinted and grouped, so one regression appears as one incident.
            </p>
          </li>
          <li>
            <p className="font-medium">3. Investigate with AI</p>
            <p className="text-muted-foreground">
              Generate hypotheses that cite the exact events supporting each explanation.
            </p>
          </li>
        </ol>

        <div>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Shortcuts</h3>
          <dl className="space-y-1.5 text-sm">
            {SHORTCUTS.map(([keys, action]) => (
              <div key={keys} className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">{action}</dt>
                <dd>
                  <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">{keys}</kbd>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </DialogContent>
    </Dialog>
  );
}
