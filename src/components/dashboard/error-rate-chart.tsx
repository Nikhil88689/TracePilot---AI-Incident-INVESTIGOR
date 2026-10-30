"use client";

import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatNumber, formatPercent } from "@/lib/dashboard/format";
import type { ErrorRatePoint, TimeRange } from "@/lib/dashboard/types";

export type ChartDeployment = { id: string; version: string; deployedAt: string; description: string | null };

type Props = { data: ErrorRatePoint[]; range: TimeRange; deployments?: ChartDeployment[] };

function formatTick(iso: string, range: TimeRange): string {
  const date = new Date(iso);
  return range === "7d"
    ? date.toLocaleDateString("en-US", { weekday: "short", day: "numeric", timeZone: "UTC" })
    : date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
}

function formatTooltipTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }) + " UTC";
}

type TooltipProps = { active?: boolean; payload?: { payload: ErrorRatePoint }[] };

function ChartTooltip({ active, payload }: TooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium">{formatTooltipTime(point.time)}</p>
      {point.rate === null ? (
        <p className="text-muted-foreground">No events in this interval</p>
      ) : (
        <>
          <p className="tabular-nums">
            <span className="text-muted-foreground">Error rate </span>
            <span className="font-semibold">{formatPercent(point.rate, 1)}</span>
          </p>
          <p className="tabular-nums text-muted-foreground">
            {formatNumber(point.errors)} errors / {formatNumber(point.events)} events
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Error rate per interval. An interval with no events has no rate, so it is a gap in the line, not a
 * 0% point. Times are shown in UTC to match every query. Deployments in the window are drawn as
 * dashed vertical markers.
 */
export function ErrorRateChart({ data, range, deployments = [] }: Props) {
  const rated = data.filter((p): p is ErrorRatePoint & { rate: number } => p.rate !== null);
  const peak = rated.reduce<(ErrorRatePoint & { rate: number }) | null>((max, p) => (max === null || p.rate > max.rate ? p : max), null);
  const average = rated.length === 0 ? null : rated.reduce((sum, p) => sum + p.rate, 0) / rated.length;
  const gaps = data.length - rated.length;
  const summary =
    peak && average !== null
      ? `Error rate over time (UTC). Average ${formatPercent(average)}, peaking at ${formatPercent(peak.rate)} around ${formatTooltipTime(peak.time)}.${gaps > 0 ? ` ${gaps} interval${gaps === 1 ? " has" : "s have"} no events.` : ""}${deployments.length > 0 ? ` Deployments: ${deployments.map((d) => `${d.version} at ${formatTooltipTime(d.deployedAt)}`).join("; ")}.` : ""}`
      : "No error rate data: no events in this window.";

  // The axis tops out at the first "nice" value above the peak (so quarter ticks are whole numbers), never an odd 115%.
  const yTop = [4, 8, 20, 40, 100].find((t) => t >= (peak?.rate ?? 0)) ?? 100;
  // A lone point between gaps would draw nothing as a line or area, so mark it with a dot.
  const isolated = new Set(
    data.flatMap((p, i) => (p.rate !== null && (i === 0 || data[i - 1].rate === null) && (i === data.length - 1 || data[i + 1].rate === null) ? [i] : [])),
  );

  // Snap each deployment marker to the bucket that contains it (the x axis is categorical).
  const times = data.map((p) => Date.parse(p.time));
  const markers = deployments.flatMap((d) => {
    const at = Date.parse(d.deployedAt);
    let index = -1;
    for (let i = 0; i < times.length; i++) if (times[i] <= at) index = i;
    return index === -1 ? [] : [{ ...d, x: data[index].time }];
  });

  return (
    <div role="img" aria-label={summary} className="size-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 16, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="errorRateFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.25} />
              <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="time"
            tickFormatter={(value: string) => formatTick(value, range)}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            minTickGap={32}
          />
          <YAxis
            tickFormatter={(value: number) => `${value}%`}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={40}
            allowDecimals={false}
            domain={[0, yTop]}
            ticks={[0, yTop / 4, yTop / 2, (yTop * 3) / 4, yTop]}
          />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: "var(--ring)", strokeOpacity: 0.4 }} />
          {markers.map((m, i) => (
            <ReferenceLine
              key={m.id}
              x={m.x}
              stroke="var(--warning)"
              strokeDasharray="4 3"
              // Deploy and rollback are often only minutes apart, so their labels would overprint each other.
              // Each sits to the left of its own line, one row lower than the previous marker.
              label={{ value: `v${m.version}`, position: "insideTopLeft", dy: i * 13, fill: "var(--warning)", fontSize: 10 }}
            />
          ))}
          <Area
            type="monotone"
            dataKey="rate"
            connectNulls={false}
            stroke="var(--chart-1)"
            strokeWidth={2}
            fill="url(#errorRateFill)"
            dot={(p: { cx?: number; cy?: number; index?: number }) =>
              isolated.has(p.index ?? -1) ? <circle key={`dot-${p.index}`} cx={p.cx} cy={p.cy} r={3.5} fill="var(--chart-1)" /> : <g key={`dot-${p.index}`} />
            }
            activeDot={{ r: 4, fill: "var(--chart-1)", stroke: "var(--card)", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
