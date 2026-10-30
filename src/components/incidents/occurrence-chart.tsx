"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { HistogramBucket } from "@/lib/incidents/types";

function label(iso: string, spanMs: number): string {
  // UTC like every other timestamp in the app. A short span needs seconds, or every tick reads the same minute.
  const d = new Date(iso);
  if (spanMs > 2 * 86_400_000) return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", ...(spanMs < 15 * 60_000 ? { second: "2-digit" } : {}), hour12: false, timeZone: "UTC" });
}

type TipProps = { active?: boolean; payload?: { payload: HistogramBucket }[] };

function Tip({ active, payload }: TipProps) {
  const b = payload?.[0]?.payload;
  if (!active || !b) return null;
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <p className="font-medium">{new Date(b.start).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" })} UTC</p>
      <p className="tabular-nums text-muted-foreground">
        {b.count} {b.count === 1 ? "occurrence" : "occurrences"}
      </p>
    </div>
  );
}

/** Real per-bucket occurrence counts for one incident (from incident_histogram). */
export function OccurrenceChart({ buckets }: { buckets: HistogramBucket[] }) {
  const total = buckets.reduce((s, b) => s + b.count, 0);
  const span = buckets.length ? Date.parse(buckets[buckets.length - 1].end) - Date.parse(buckets[0].start) : 0;
  const peak = buckets.reduce((m, b) => (b.count > m.count ? b : m), buckets[0] ?? { start: "", end: "", count: 0 });

  return (
    <div
      role="img"
      aria-label={`Occurrences over time: ${total} in total${peak?.count ? `, peaking at ${peak.count} around ${new Date(peak.start).toLocaleString("en-US", { timeZone: "UTC" })} UTC` : ""}.`}
      className="size-full"
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={buckets} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="start" tickFormatter={(v: string) => label(v, span)} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={32} />
          <YAxis allowDecimals={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} axisLine={false} tickLine={false} width={32} />
          <Tooltip content={<Tip />} cursor={{ fill: "var(--accent)" }} />
          <Bar dataKey="count" fill="var(--chart-1)" radius={[2, 2, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
