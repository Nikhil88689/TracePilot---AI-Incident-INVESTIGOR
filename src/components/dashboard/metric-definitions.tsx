import { Info } from "lucide-react";
import { METRIC_DEFINITIONS, MIN_BASELINE_EVENTS, type MetricId } from "@/lib/dashboard/metrics";

const ORDER: MetricId[] = ["events", "errorRate", "unresolved", "endpoints", "severity", "series"];

/** "How are these calculated?": the same definitions the code uses (src/lib/dashboard/metrics.ts). */
export function MetricDefinitions() {
  return (
    <details className="group rounded-lg border border-border bg-card px-4 py-2.5 text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-medium [&::-webkit-details-marker]:hidden">
        <Info className="size-4 text-muted-foreground" aria-hidden /> How these numbers are calculated
      </summary>
      <dl className="mt-3 space-y-3">
        {ORDER.map((id) => (
          <div key={id}>
            <dt className="font-medium">{METRIC_DEFINITIONS[id].label}</dt>
            <dd className="font-mono text-xs text-muted-foreground">{METRIC_DEFINITIONS[id].formula}</dd>
            <dd className="mt-0.5 text-xs text-muted-foreground">{METRIC_DEFINITIONS[id].detail}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
        All times are UTC and windows are half-open: an event at exactly the start is included, one at exactly the end is not. The
        previous period has the same length and ends where the current one starts. A trend is shown only when TracePilot has data
        from before the previous period began and the previous value is non-zero; an error-rate trend also needs at least{" "}
        {MIN_BASELINE_EVENTS} events in the previous period. Otherwise the card says why there is no comparison.
      </p>
    </details>
  );
}
