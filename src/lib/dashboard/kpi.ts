import { formatChange, formatNumber, formatPercent } from "./format";
import type { Kpi, KpiTone } from "./types";

export function formatKpiValue(kpi: Pick<Kpi, "value" | "format">): string {
  return kpi.format === "percent" ? formatPercent(kpi.value) : formatNumber(kpi.value);
}

/** Whether a change is good/bad/neutral depends on what the metric means, not only its sign. */
export function trendTone(kpi: Pick<Kpi, "changePercent" | "higherIs">): KpiTone {
  if (kpi.changePercent === null || kpi.changePercent === 0 || kpi.higherIs === "neutral") return "neutral";
  return kpi.changePercent > 0 ? "bad" : "good";
}

export type TrendDirection = "up" | "down" | "flat" | "none";

export function trendDirection(changePercent: number | null): TrendDirection {
  if (changePercent === null) return "none";
  if (changePercent > 0) return "up";
  if (changePercent < 0) return "down";
  return "flat";
}

/** Screen-reader text so the trend is never conveyed by color or an arrow alone. */
export function trendDescription(kpi: Pick<Kpi, "changePercent">, comparison: string): string {
  if (kpi.changePercent === null) return "No comparison data available";
  if (kpi.changePercent === 0) return `No change ${comparison}`;
  const word = kpi.changePercent > 0 ? "Up" : "Down";
  return `${word} ${formatChange(Math.abs(kpi.changePercent)).replace(/^[+-]/, "")} ${comparison}`;
}
