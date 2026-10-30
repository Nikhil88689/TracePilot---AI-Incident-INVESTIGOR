"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { formatNumber } from "@/lib/dashboard/format";
import type { SeverityCount } from "@/lib/dashboard/types";
import { SEVERITY_LABELS } from "./status-badges";

export function SeverityChart({ data }: { data: SeverityCount[] }) {
  const total = data.reduce((sum, d) => sum + d.count, 0);
  const slices = data.filter((d) => d.count > 0);

  return (
    <div className="flex size-full flex-col gap-4 sm:flex-row sm:items-center lg:flex-col lg:items-stretch xl:flex-row xl:items-center">
      <div
        role="img"
        aria-label={`Unresolved incidents by severity: ${data.map((d) => `${d.count} ${d.severity}`).join(", ")}.`}
        className="relative mx-auto size-40 shrink-0"
      >
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="count"
              nameKey="severity"
              innerRadius={52}
              outerRadius={74}
              paddingAngle={2}
              stroke="var(--card)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {slices.map((d) => (
                <Cell key={d.severity} fill={`var(--severity-${d.severity})`} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value, name) => [formatNumber(Number(value)), SEVERITY_LABELS[name as SeverityCount["severity"]]]}
              contentStyle={{
                background: "var(--popover)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                fontSize: 12,
              }}
              itemStyle={{ color: "var(--foreground)" }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold tabular-nums">{total}</span>
          <span className="text-xs text-muted-foreground">unresolved</span>
        </div>
      </div>

      <ul className="flex-1 space-y-2 text-sm">
        {data.map((d) => (
          <li key={d.severity} className="flex items-center gap-2">
            <span aria-hidden className="size-2.5 rounded-sm" style={{ background: `var(--severity-${d.severity})` }} />
            <span className="flex-1">{SEVERITY_LABELS[d.severity]}</span>
            <span className="tabular-nums font-medium">{d.count}</span>
            <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
              {total === 0 ? "0%" : `${Math.round((d.count / total) * 100)}%`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
