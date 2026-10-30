"use client";

import Link from "next/link";
import { ArrowRight, Lightbulb, X } from "lucide-react";
import { useDashboardParams } from "@/components/layout/shell-context";
import { Button } from "@/components/ui/button";
import { useStoredFlag } from "@/lib/use-stored-flag";

export const DEMO_CALLOUT_KEY = "tracepilot.demo.callout.dismissed";

const COPY = {
  dashboard: {
    title: "Start here",
    body: "The error rate spiked about two hours ago, right after deployment v2.14.0 (the dashed line). Open the checkout incident to find out why.",
    cta: "Open the incident",
  },
  incident: {
    title: "Next",
    body: "Expand a stack trace and check the event times, then run the AI investigation (a simulated one is already attached), review its evidence, and resolve the incident.",
    cta: null,
  },
} as const;

/**
 * One short, dismissible hint for the demo walkthrough, shown only inside the demo project. Dismissal
 * is remembered in this browser; there is deliberately no multi-step tour.
 */
export function DemoCallout({ step, incidentsHref }: { step: keyof typeof COPY; incidentsHref?: string }) {
  const { project } = useDashboardParams();
  const [dismissed, dismiss] = useStoredFlag(DEMO_CALLOUT_KEY);
  if (!project?.isDemo || dismissed) return null;
  const copy = COPY[step];

  return (
    <aside aria-label="Demo hint" className="flex items-start gap-3 rounded-lg border border-primary/30 bg-primary/10 px-4 py-3 text-sm">
      <Lightbulb className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <p>
          <strong>{copy.title}:</strong> {copy.body}
        </p>
        {copy.cta && incidentsHref ? (
          <Link href={incidentsHref} className="mt-1.5 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
            {copy.cta} <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        ) : null}
      </div>
      <Button variant="ghost" size="icon-sm" onClick={dismiss} aria-label="Dismiss demo hint">
        <X aria-hidden />
      </Button>
    </aside>
  );
}
