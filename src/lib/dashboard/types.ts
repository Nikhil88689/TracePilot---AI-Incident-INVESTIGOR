export const TIME_RANGES = ["1h", "24h", "7d"] as const;
export type TimeRange = (typeof TIME_RANGES)[number];

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const INCIDENT_STATUSES = ["open", "investigating", "resolved"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export type Project = {
  id: string;
  name: string;
  workspace: string;
  environment: string;
  /** True for the simulated demo project. */
  isDemo?: boolean;
};

export type ErrorRatePoint = {
  /** ISO 8601 bucket start */
  time: string;
  events: number;
  errors: number;
  /** errors / events as a percentage (0-100); null when the bucket has no events (a gap, never 0%). */
  rate: number | null;
};

export type KpiTone = "good" | "bad" | "neutral";

export type Kpi = {
  id: "events" | "errorRate" | "unresolved" | "endpoints";
  label: string;
  value: number;
  format: "number" | "percent";
  /** Percentage change versus the previous period; null whenever a comparison would not be meaningful. */
  changePercent: number | null;
  /** Why there is no trend (shown to the user), or null. */
  trendNote: string | null;
  /** Extra context under the value, e.g. "12 errors of 340 events". */
  detail: string | null;
  /** Whether an increase is bad (errors) or neutral (traffic). */
  higherIs: "bad" | "neutral";
};

export type SeverityCount = { severity: Severity; count: number };

export type DashboardOverview = {
  /** ISO 8601 time the snapshot was produced; all relative times derive from it. */
  generatedAt: string;
  range: TimeRange;
  kpis: Kpi[];
  series: ErrorRatePoint[];
  severityBreakdown: SeverityCount[];
};
