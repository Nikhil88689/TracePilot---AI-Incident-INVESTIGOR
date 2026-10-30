import { Activity, Route, Siren, TriangleAlert, type LucideIcon } from "lucide-react";
import { RANGE_COMPARISON } from "@/lib/dashboard/params";
import { formatKpiValue, trendTone } from "@/lib/dashboard/kpi";
import type { Kpi, TimeRange } from "@/lib/dashboard/types";
import { MetricCard } from "./metric-card";

const ICONS: Record<Kpi["id"], LucideIcon> = {
  events: Activity,
  errorRate: TriangleAlert,
  unresolved: Siren,
  endpoints: Route,
};

/**
 * Links that open the list a KPI was counted from, in the same window, so a viewer can check that the
 * number agrees with the data. (Error rate and affected endpoints are derived, so they have no list.)
 */
export function kpiHref(id: Kpi["id"], range: TimeRange, projectId: string | null): string | undefined {
  const params = new URLSearchParams();
  if (projectId) params.set("project", projectId);
  if (id === "events") {
    params.set("since", range);
    return `/events?${params.toString()}`;
  }
  if (id === "unresolved") {
    params.set("status", "unresolved");
    params.set("since", range);
    return `/incidents?${params.toString()}`;
  }
  return undefined;
}

export function KpiGrid({ kpis, range, projectId = null }: { kpis: Kpi[]; range: TimeRange; projectId?: string | null }) {
  return (
    <section aria-label="Key metrics" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {kpis.map((kpi) => (
        <MetricCard
          key={kpi.id}
          label={kpi.label}
          value={formatKpiValue(kpi)}
          icon={ICONS[kpi.id]}
          changePercent={kpi.changePercent}
          trendNote={kpi.trendNote}
          detail={kpi.detail}
          tone={trendTone(kpi)}
          comparison={RANGE_COMPARISON[range]}
          href={kpiHref(kpi.id, range, projectId)}
        />
      ))}
    </section>
  );
}
