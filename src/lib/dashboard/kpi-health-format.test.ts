import { describe, expect, it } from "vitest";
import { formatChange, formatRelative, initialsFromEmail } from "./format";
import { deriveHealth } from "./health";
import { formatKpiValue, trendDescription, trendTone } from "./kpi";
import { parseRange, resolveProjectId } from "./params";
import type { Kpi } from "./types";

const kpi = (overrides: Partial<Kpi>): Kpi => ({
  id: "errorRate",
  label: "Error rate",
  value: 2.4,
  format: "percent",
  changePercent: 5,
  trendNote: null,
  detail: null,
  higherIs: "bad",
  ...overrides,
});

describe("trendTone", () => {
  it("treats an increase in a bad metric as bad and a decrease as good", () => {
    expect(trendTone(kpi({ changePercent: 5 }))).toBe("bad");
    expect(trendTone(kpi({ changePercent: -5 }))).toBe("good");
  });
  it("is neutral for traffic, zero, or missing baselines", () => {
    expect(trendTone(kpi({ higherIs: "neutral", changePercent: 20 }))).toBe("neutral");
    expect(trendTone(kpi({ changePercent: 0 }))).toBe("neutral");
    expect(trendTone(kpi({ changePercent: null }))).toBe("neutral");
  });
});

describe("kpi formatting", () => {
  it("formats values by type", () => {
    expect(formatKpiValue({ value: 12486, format: "number" })).toBe("12,486");
    expect(formatKpiValue({ value: 2.4, format: "percent" })).toBe("2.4%");
  });
  it("describes trends in words for screen readers", () => {
    expect(trendDescription({ changePercent: 8.2 }, "vs previous 24 hours")).toBe("Up 8.2% vs previous 24 hours");
    expect(trendDescription({ changePercent: -3 }, "vs previous hour")).toBe("Down 3.0% vs previous hour");
    expect(trendDescription({ changePercent: null }, "x")).toMatch(/No comparison/);
  });
});

describe("format helpers", () => {
  it("formats signed changes", () => {
    expect(formatChange(8.24)).toBe("+8.2%");
    expect(formatChange(-3)).toBe("-3.0%");
    expect(formatChange(0)).toBe("0.0%");
  });
  it("formats relative time against a supplied now", () => {
    const now = "2026-10-29T12:00:00.000Z";
    expect(formatRelative("2026-10-29T11:59:50.000Z", now)).toBe("just now");
    expect(formatRelative("2026-10-29T11:48:00.000Z", now)).toBe("12m ago");
    expect(formatRelative("2026-10-29T07:00:00.000Z", now)).toBe("5h ago");
    expect(formatRelative("2026-10-26T12:00:00.000Z", now)).toBe("3d ago");
  });
  it("derives initials", () => {
    expect(initialsFromEmail("nikhil.pratap@x.com")).toBe("NP");
    expect(initialsFromEmail("dev@x.com")).toBe("DE");
  });
});

describe("param parsing", () => {
  it("falls back to the default range for junk input", () => {
    expect(parseRange("7d")).toBe("7d");
    expect(parseRange("999y")).toBe("24h");
    expect(parseRange(undefined)).toBe("24h");
  });
  it("only accepts known project ids", () => {
    const projects = [{ id: "a" }, { id: "b" }];
    expect(resolveProjectId("b", projects)).toBe("b");
    expect(resolveProjectId("../etc", projects)).toBe(""); // unknown => all projects
    expect(resolveProjectId(undefined, projects)).toBe("");
    expect(resolveProjectId("a", [])).toBe("");
  });
});

describe("deriveHealth", () => {
  const kpis = (events: number, rate: number) => [
    { id: "events", value: events },
    { id: "errorRate", value: rate },
  ] as Kpi[];
  const base = {
    series: [{ time: "t", events: 100, errors: 1, rate: 1 }],
    kpis: kpis(100, 1),
    criticalUnresolved: 0,
  };

  it("does not judge a rate from too few events (1 error of 1 event is not a 100% outage)", () => {
    const h = deriveHealth({ ...base, kpis: kpis(1, 100) });
    expect(h).toMatchObject({ level: "idle", label: "Limited data" });
    expect(h.detail).toContain("Only 1 event ");
    expect(deriveHealth({ ...base, kpis: kpis(19, 50) }).level).toBe("idle");
    expect(deriveHealth({ ...base, kpis: kpis(20, 50) }).level).toBe("critical");
  });

  it("still reports an unresolved critical incident when data is limited", () => {
    expect(deriveHealth({ ...base, kpis: kpis(3, 100), criticalUnresolved: 1 }).level).toBe("critical");
  });

  it("is idle with no events", () => {
    expect(deriveHealth({ ...base, series: [], kpis: kpis(0, 0) }).level).toBe("idle");
  });
  it("is healthy at a low error rate", () => {
    expect(deriveHealth(base).level).toBe("healthy");
  });
  it("degrades at elevated error rate", () => {
    expect(deriveHealth({ ...base, kpis: kpis(100, 3) }).level).toBe("degraded");
  });
  it("goes critical for unresolved critical incidents or a very high error rate", () => {
    expect(deriveHealth({ ...base, criticalUnresolved: 2 })).toMatchObject({ level: "critical", detail: "2 unresolved critical incidents." });
    expect(deriveHealth({ ...base, criticalUnresolved: 1 }).detail).toBe("1 unresolved critical incident.");
    expect(deriveHealth({ ...base, kpis: kpis(100, 6) }).level).toBe("critical");
  });
});
