/**
 * Dashboard metric definitions: the single source of truth for what each number means, how time windows
 * work, and when a trend may be shown. The SQL (`dashboard_overview`) computes the raw counts with the
 * same definitions; this module turns them into displayed values and refuses to invent comparisons.
 *
 * TIME. Everything is UTC and every window is half-open, [from, to): an event at exactly `from` is
 * inside the window and an event at exactly `to` is outside it. `to` is the moment the page was
 * rendered. The comparison ("previous") window has the same length and ends where this one starts.
 */

import type { TimeRange } from "./types";

/** Event levels that count as errors. Anything else (debug, info, warning) is traffic but not an error. */
export const ERROR_LEVELS = ["error", "fatal"] as const;

/**
 * A rate computed from a handful of events is noise. An error-rate trend is only shown when the previous
 * window contains at least this many events.
 */
export const MIN_BASELINE_EVENTS = 20;

export type MetricId = "events" | "errorRate" | "unresolved" | "endpoints" | "severity" | "series";

export type MetricDefinition = {
  label: string;
  /** Short formula, shown to users. */
  formula: string;
  /** Precise definition including edge cases. */
  detail: string;
};

export const METRIC_DEFINITIONS: Record<MetricId, MetricDefinition> = {
  events: {
    label: "Total events",
    formula: "count(events in window)",
    detail: "Every event received with a timestamp inside the selected window, of any level (debug, info, warning, error, fatal).",
  },
  errorRate: {
    label: "Error rate",
    formula: "error and fatal events ÷ all events in window",
    detail:
      "Numerator: events whose level is error or fatal. Denominator: all events in the window. Undefined (shown as no value, never 0%) when the window has no events.",
  },
  unresolved: {
    label: "Unresolved incidents",
    formula: "count(incidents where status ≠ resolved and last seen in window)",
    detail:
      "Open or investigating incidents with activity inside the window. It equals the Incidents page filtered to 'Unresolved' and the same last-seen window. No trend is shown: TracePilot does not snapshot incident status over time, so a previous-period count would be misleading.",
  },
  endpoints: {
    label: "Affected endpoints",
    formula: "count(distinct endpoint among error and fatal events in window)",
    detail: "Distinct non-empty endpoints that produced at least one error or fatal event in the window.",
  },
  severity: {
    label: "Severity distribution",
    formula: "unresolved incidents in window, grouped by severity",
    detail: "The same set of incidents as 'Unresolved incidents', split into critical, high, medium and low.",
  },
  series: {
    label: "Error-rate chart",
    formula: "per bucket: error and fatal events ÷ all events in that bucket",
    detail:
      "The window is split into equal buckets (12 for 1 hour, 24 for 24 hours, 28 for 7 days). A bucket with no events has no rate and appears as a gap, never as 0%.",
  },
};

export const RANGE_BUCKETS: Record<TimeRange, number> = { "1h": 12, "24h": 24, "7d": 28 };

/** Error rate as a percentage rounded to one decimal, or null when there are no events. */
export function errorRate(errors: number, events: number): number | null {
  if (events <= 0) return null;
  return Math.round((errors / events) * 1000) / 10;
}

export type WindowBounds = { from: Date; to: Date; previousFrom: Date };

/** The [from, to) window ending at `now`, plus where the comparison window starts. */
export function windowBounds(now: Date, rangeMs: number): WindowBounds {
  const to = now;
  const from = new Date(to.getTime() - rangeMs);
  return { from, to, previousFrom: new Date(from.getTime() - rangeMs) };
}

/** Whether TracePilot has any history at or before the start of the comparison window. */
export function baselineCovered(firstEventAt: string | null, previousFrom: Date): boolean {
  return firstEventAt !== null && Date.parse(firstEventAt) <= previousFrom.getTime();
}

export type TrendResult = { changePercent: number | null; trendNote: string | null };

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Percentage change vs the previous window, or an explanation of why there is none. A trend is only
 * produced when it would be meaningful: history must cover the comparison window, and the previous
 * value must be non-zero (a percentage of zero is undefined). Rates also need enough events.
 */
export function computeTrend(input: {
  kind: "count" | "rate";
  current: number | null;
  previous: number | null;
  covered: boolean;
  baselineEvents: number;
}): TrendResult {
  const { kind, current, previous, covered, baselineEvents } = input;
  if (!covered) return { changePercent: null, trendNote: "No comparison yet: TracePilot has no data from before the previous period." };
  if (current === null) return { changePercent: null, trendNote: "No events in this period to compare." };
  if (kind === "rate" && baselineEvents < MIN_BASELINE_EVENTS) {
    return { changePercent: null, trendNote: `No comparison: the previous period had only ${baselineEvents} events (at least ${MIN_BASELINE_EVENTS} needed for a rate).` };
  }
  if (previous === null || previous === 0) return { changePercent: null, trendNote: "No comparison: the previous period was zero, so a percentage change is undefined." };
  return { changePercent: round1(((current - previous) / previous) * 100), trendNote: null };
}
