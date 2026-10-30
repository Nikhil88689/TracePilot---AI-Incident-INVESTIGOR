import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { IncidentTableSkeleton } from "@/components/incidents/incident-table";
import { ChartCardSkeleton } from "./chart-card";
import { MetricCardSkeleton } from "./metric-card";

export function PageHeaderSkeleton() {
  return (
    <div className="space-y-2" aria-hidden>
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-4 w-80 max-w-full" />
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-busy="true" aria-label="Loading dashboard">
      <PageHeaderSkeleton />
      <Skeleton className="h-11 w-full" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <MetricCardSkeleton key={i} />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <ChartCardSkeleton className="lg:col-span-2" />
        <ChartCardSkeleton />
      </div>
      <Card className="p-0">
        <IncidentTableSkeleton rows={6} />
      </Card>
    </div>
  );
}

export function ListPageSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-busy="true" aria-label="Loading">
      <PageHeaderSkeleton />
      <div className="grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <MetricCardSkeleton key={i} />
        ))}
      </div>
      <Card className="p-0">
        <IncidentTableSkeleton rows={8} />
      </Card>
    </div>
  );
}

export function DetailPageSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-busy="true" aria-label="Loading incident">
      <Skeleton className="h-8 w-32" />
      <PageHeaderSkeleton />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <div className="grid gap-4 sm:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <MetricCardSkeleton key={i} />
            ))}
          </div>
          <ChartCardSkeleton />
          <Skeleton className="h-48 w-full" />
        </div>
        <Skeleton className="h-72 w-full" />
      </div>
    </div>
  );
}
