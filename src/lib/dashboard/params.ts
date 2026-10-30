import { TIME_RANGES, type Project, type TimeRange } from "./types";

export const DEFAULT_RANGE: TimeRange = "24h";

export const RANGE_LABELS: Record<TimeRange, string> = {
  "1h": "1 hour",
  "24h": "24 hours",
  "7d": "7 days",
};

export const RANGE_COMPARISON: Record<TimeRange, string> = {
  "1h": "vs previous hour",
  "24h": "vs previous 24 hours",
  "7d": "vs previous 7 days",
};

export const RANGE_MS: Record<TimeRange, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

/** Untrusted URL input -> a valid range, never throwing. */
export function parseRange(value: unknown): TimeRange {
  return typeof value === "string" && (TIME_RANGES as readonly string[]).includes(value)
    ? (value as TimeRange)
    : DEFAULT_RANGE;
}

/** Untrusted URL input -> an existing project id, or "" meaning all projects. */
export function resolveProjectId(value: unknown, projects: Pick<Project, "id">[]): string {
  return (typeof value === "string" ? projects.find((p) => p.id === value)?.id : undefined) ?? "";
}
