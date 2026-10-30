import { MIN_BASELINE_EVENTS } from "./metrics";
import type { DashboardOverview } from "./types";

export type HealthLevel = "healthy" | "degraded" | "critical" | "idle";

export type ProjectHealth = { level: HealthLevel; label: string; detail: string };

/**
 * Derives health from the overview so the rule lives in one place, not in the UI.
 * `criticalUnresolved` is the number of critical incidents that are not yet resolved.
 */
export function deriveHealth(
  overview: Pick<DashboardOverview, "kpis" | "series"> & { criticalUnresolved: number },
): ProjectHealth {
  const totalEvents = overview.kpis.find((k) => k.id === "events")?.value ?? 0;
  if (totalEvents === 0 || overview.series.length === 0) {
    return { level: "idle", label: "No data", detail: "No events received in this time range." };
  }

  const openCritical = overview.criticalUnresolved;

  // A rate from a handful of events is noise (1 error of 1 event is "100%"). Judge by the rate only with enough
  // events; an unresolved critical incident is still reported regardless.
  if (totalEvents < MIN_BASELINE_EVENTS && openCritical === 0) {
    return {
      level: "idle",
      label: "Limited data",
      detail: `Only ${totalEvents} ${totalEvents === 1 ? "event" : "events"} in this range, too few to judge the error rate (needs ${MIN_BASELINE_EVENTS}).`,
    };
  }

  const errorRate = overview.kpis.find((k) => k.id === "errorRate")?.value ?? 0;
  if (openCritical > 0 || errorRate >= 5) {
    return {
      level: "critical",
      label: "Critical",
      detail:
        openCritical > 0
          ? `${openCritical} unresolved critical ${openCritical === 1 ? "incident" : "incidents"}.`
          : `Error rate is ${errorRate.toFixed(1)}%.`,
    };
  }
  if (errorRate >= 2) {
    return { level: "degraded", label: "Degraded", detail: `Error rate is elevated at ${errorRate.toFixed(1)}%.` };
  }
  return { level: "healthy", label: "Healthy", detail: "Error rate is within the expected range." };
}
