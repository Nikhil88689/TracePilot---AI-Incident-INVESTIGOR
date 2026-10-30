import { describe, expect, it } from "vitest";
import { METRIC_DEFINITIONS, MIN_BASELINE_EVENTS, RANGE_BUCKETS, baselineCovered, computeTrend, errorRate, windowBounds } from "./metrics";

describe("errorRate", () => {
  it("is errors / events as a one-decimal percentage", () => {
    expect(errorRate(84, 228)).toBe(36.8);
    expect(errorRate(1, 3)).toBe(33.3);
    expect(errorRate(0, 50)).toBe(0);
    expect(errorRate(50, 50)).toBe(100);
  });

  it("is null, never 0%, when there are no events", () => {
    expect(errorRate(0, 0)).toBeNull();
    expect(errorRate(3, 0)).toBeNull(); // inconsistent input still cannot divide by zero
  });
});

describe("windowBounds", () => {
  const now = new Date("2026-06-01T12:00:00.000Z");
  it("builds a half-open window ending at now plus an equal-length previous window", () => {
    const b = windowBounds(now, 3_600_000);
    expect(b.to.toISOString()).toBe("2026-06-01T12:00:00.000Z");
    expect(b.from.toISOString()).toBe("2026-06-01T11:00:00.000Z");
    expect(b.previousFrom.toISOString()).toBe("2026-06-01T10:00:00.000Z");
  });

  it("does not mutate its input and is UTC arithmetic (no DST shifts)", () => {
    const dst = new Date("2026-03-29T01:30:00.000Z");
    const b = windowBounds(dst, 24 * 3_600_000);
    expect(b.from.toISOString()).toBe("2026-03-28T01:30:00.000Z");
    expect(dst.toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });
});

describe("baselineCovered", () => {
  const previousFrom = new Date("2026-06-01T00:00:00.000Z");
  it("requires history at or before the start of the comparison window", () => {
    expect(baselineCovered(null, previousFrom)).toBe(false);
    expect(baselineCovered("2026-06-01T00:00:00.001Z", previousFrom)).toBe(false);
    expect(baselineCovered("2026-06-01T00:00:00.000Z", previousFrom)).toBe(true); // boundary is inclusive
    expect(baselineCovered("2026-01-01T00:00:00.000Z", previousFrom)).toBe(true);
  });
});

describe("computeTrend", () => {
  const base = { covered: true, baselineEvents: 100 };

  it("computes a rounded percentage change when a comparison is meaningful", () => {
    expect(computeTrend({ kind: "count", current: 228, previous: 144, ...base })).toEqual({ changePercent: 58.3, trendNote: null });
    expect(computeTrend({ kind: "count", current: 50, previous: 100, ...base })).toEqual({ changePercent: -50, trendNote: null });
    expect(computeTrend({ kind: "count", current: 100, previous: 100, ...base })).toEqual({ changePercent: 0, trendNote: null });
    expect(computeTrend({ kind: "rate", current: 20, previous: 10, ...base })).toEqual({ changePercent: 100, trendNote: null });
  });

  it("refuses to compare without history, and says why", () => {
    const r = computeTrend({ kind: "count", current: 5, previous: 4, covered: false, baselineEvents: 4 });
    expect(r.changePercent).toBeNull();
    expect(r.trendNote).toMatch(/no data from before the previous period/);
  });

  it("refuses when there is no current value", () => {
    const r = computeTrend({ kind: "rate", current: null, previous: 5, ...base });
    expect(r.changePercent).toBeNull();
    expect(r.trendNote).toMatch(/No events in this period/);
  });

  it("refuses to divide by a zero or missing previous value", () => {
    for (const previous of [0, null]) {
      const r = computeTrend({ kind: "count", current: 10, previous, ...base });
      expect(r.changePercent).toBeNull();
      expect(r.trendNote).toMatch(/previous period was zero/);
    }
  });

  it("requires enough baseline events for rates, but not for counts", () => {
    const thin = computeTrend({ kind: "rate", current: 10, previous: 5, covered: true, baselineEvents: MIN_BASELINE_EVENTS - 1 });
    expect(thin.changePercent).toBeNull();
    expect(thin.trendNote).toContain(`only ${MIN_BASELINE_EVENTS - 1} events`);
    expect(computeTrend({ kind: "rate", current: 10, previous: 5, covered: true, baselineEvents: MIN_BASELINE_EVENTS }).changePercent).toBe(100);
    expect(computeTrend({ kind: "count", current: 10, previous: 5, covered: true, baselineEvents: 1 }).changePercent).toBe(100);
  });
});

describe("definitions", () => {
  it("document every metric with a formula", () => {
    for (const id of ["events", "errorRate", "unresolved", "endpoints", "severity", "series"] as const) {
      expect(METRIC_DEFINITIONS[id].label).toBeTruthy();
      expect(METRIC_DEFINITIONS[id].formula).toBeTruthy();
      expect(METRIC_DEFINITIONS[id].detail.length).toBeGreaterThan(20);
    }
    expect(METRIC_DEFINITIONS.errorRate.detail).toMatch(/never 0%/);
  });

  it("uses the documented bucket counts", () => {
    expect(RANGE_BUCKETS).toEqual({ "1h": 12, "24h": 24, "7d": 28 });
  });
});
