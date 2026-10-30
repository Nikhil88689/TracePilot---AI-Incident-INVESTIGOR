"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CheckCircle2, Eye, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { IncidentStatus } from "@/lib/dashboard/types";
import { changeStatusAction } from "@/lib/incidents/actions";
import { STATUS_LABELS, actionsFor, type StatusAction } from "@/lib/incidents/transitions";

const ICONS = { acknowledge: Eye, resolve: CheckCircle2, reopen: RotateCcw } as const;

/**
 * Acknowledge / Resolve / Reopen. Deliberately not optimistic: the server is the source of truth
 * (it checks ownership, the expected current status, and the transition rules), so the buttons show
 * a pending state and the page refreshes from the confirmed result. Nothing needs rolling back.
 */
export function StatusActions({ incidentId, status }: { incidentId: string; status: IncidentStatus }) {
  const router = useRouter();
  const [pendingAction, setPendingAction] = useState<StatusAction["id"] | null>(null);
  const [error, setError] = useState<string>();
  const [isPending, startTransition] = useTransition();

  // Buttons stay disabled for the whole transition: the server action AND the refresh that brings the new status.
  // Re-enabling them as soon as the action returns lets a quick second click send a stale `expected` status and get a
  // misleading conflict.

  function run(action: StatusAction) {
    setError(undefined);
    setPendingAction(action.id);
    startTransition(async () => {
      try {
        const result = await changeStatusAction({ incidentId, to: action.to, expected: status });
        if (result.status === "ok") {
          toast.success(`Incident ${STATUS_LABELS[result.newStatus].toLowerCase()}`);
        } else if (result.status === "conflict") {
          toast.info(`Someone already changed this incident to ${STATUS_LABELS[result.current].toLowerCase()}. Showing the latest.`);
        } else {
          setError(result.message);
        }
      } finally {
        startTransition(() => router.refresh());
      }
    });
  }

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <div className="flex flex-wrap gap-2">
        {actionsFor(status).map((action) => {
          const Icon = ICONS[action.id];
          const busy = isPending && pendingAction === action.id;
          return (
            <Button
              key={action.id}
              variant={action.id === "resolve" ? "default" : "outline"}
              disabled={isPending}
              onClick={() => run(action)}
            >
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Icon aria-hidden />}
              {action.label}
            </Button>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
