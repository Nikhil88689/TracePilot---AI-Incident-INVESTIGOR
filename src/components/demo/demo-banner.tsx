"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { FlaskConical, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { useDashboardParams } from "@/components/layout/shell-context";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { removeDemoAction, startDemoAction } from "@/lib/demo/actions";

type Action = "reset" | "remove";

/**
 * Always visible while the demo project is selected, and not dismissible: simulated data must never
 * be mistaken for real monitoring. Also where the demo can be rebuilt (new demo clock) or removed.
 */
export function DemoBanner() {
  const router = useRouter();
  const { project } = useDashboardParams();
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  if (!project?.isDemo) return null;

  function run(action: Action) {
    setError(undefined);
    startTransition(async () => {
      try {
        if (action === "reset") {
          const r = await startDemoAction({ reset: true });
          if (r.status !== "ok") return setError(r.message);
          setConfirm(null);
          router.push(`/dashboard?project=${r.projectId}`);
        } else {
          const r = await removeDemoAction();
          if (r.status !== "ok") return setError(r.message);
          setConfirm(null);
          router.push("/dashboard");
        }
        router.refresh();
      } catch {
        setError("Could not reach the server. Try again.");
      }
    });
  }

  return (
    <>
      <div
        role="note"
        aria-label="Simulated demo data"
        className="mb-4 flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 px-4 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between"
      >
        <p className="flex items-start gap-2 text-warning">
          <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            <strong>Simulated demo.</strong> Everything in this project is fictional data generated for demonstration. It is not real
            production monitoring.
          </span>
        </p>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="outline" onClick={() => setConfirm("reset")}>
            <RotateCcw aria-hidden /> Reset demo
          </Button>
          <Button size="sm" variant="outline" onClick={() => setConfirm("remove")}>
            <Trash2 aria-hidden /> Remove demo
          </Button>
        </div>
      </div>

      <Dialog open={confirm !== null} onOpenChange={(open) => !open && !pending && setConfirm(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{confirm === "reset" ? "Reset the demo?" : "Remove the demo?"}</DialogTitle>
            <DialogDescription>
              {confirm === "reset"
                ? "Rebuilds the simulated project from scratch with the story timed to right now. Anything you changed in the demo (such as resolving the incident) goes back to how it started."
                : "Deletes the simulated project and all of its simulated data. Your real projects are not affected. You can create the demo again later."}
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)} disabled={pending}>
              Cancel
            </Button>
            <Button variant={confirm === "remove" ? "destructive" : "default"} onClick={() => confirm && run(confirm)} disabled={pending}>
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {confirm === "reset" ? "Reset demo" : "Remove demo"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
