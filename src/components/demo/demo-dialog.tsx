"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { FlaskConical, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { startDemoAction } from "@/lib/demo/actions";
import { DEMO } from "@/lib/demo/scenario";

type Props = { open: boolean; onOpenChange: (open: boolean) => void };

/**
 * Explicit consent before any demo data is created. The demo is always a NEW, separate project;
 * nothing is written into the user's existing projects.
 */
export function DemoDialog({ open, onOpenChange }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  function create() {
    setError(undefined);
    startTransition(async () => {
      try {
        const result = await startDemoAction({});
        if (result.status === "ok") {
          onOpenChange(false);
          router.push(`/dashboard?project=${result.projectId}`);
          router.refresh();
        } else {
          setError(result.message);
        }
      } catch {
        setError("Could not reach the server. Check your connection and try again.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical className="size-4 text-warning" aria-hidden /> Try the demo
          </DialogTitle>
          <DialogDescription>A guided example of investigating a production incident, using simulated data.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <p>
            This creates a <strong>separate project</strong> called <span className="font-mono text-xs">{DEMO.projectName}</span> in
            your account and fills it with <strong>simulated</strong> data: normal traffic, a deployment, a burst of HTTP 500s on{" "}
            <span className="font-mono text-xs">{DEMO.endpoint}</span> with related database timeouts, then a rollback and recovery.
          </p>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <li>Your existing projects and data are not touched.</li>
            <li>Demo data is never counted in your real totals; it only appears when you select the demo project.</li>
            <li>Every demo screen is labelled as simulated. You can remove the demo at any time.</li>
          </ul>
        </div>

        {error ? (
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={create} disabled={pending}>
            {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {pending ? "Creating demo…" : "Create demo project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
