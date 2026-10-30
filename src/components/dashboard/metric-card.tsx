import Link from "next/link";
import { ArrowDownRight, ArrowUpRight, Minus, type LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatChange } from "@/lib/dashboard/format";
import { trendDescription, trendDirection } from "@/lib/dashboard/kpi";
import type { KpiTone } from "@/lib/dashboard/types";
import { cn } from "@/lib/utils";

type Props = {
  label: string;
  value: string;
  icon: LucideIcon;
  changePercent: number | null;
  tone: KpiTone;
  /** e.g. "vs previous 24 hours" */
  comparison: string;
  /** Context under the value, e.g. "12 errors of 340 events". */
  detail?: string | null;
  /** Why there is no trend. Shown instead of a number, never a made-up one. */
  trendNote?: string | null;
  /** Optional link so the number can be checked against the underlying list. */
  href?: string;
};

const TONE_CLASS: Record<KpiTone, string> = {
  good: "text-success",
  bad: "text-destructive",
  neutral: "text-muted-foreground",
};

const DIRECTION_ICON = { up: ArrowUpRight, down: ArrowDownRight, flat: Minus, none: Minus } as const;

export function MetricCard({ label, value, icon: Icon, changePercent, tone, comparison, detail, trendNote, href }: Props) {
  const direction = trendDirection(changePercent);
  const TrendIcon = DIRECTION_ICON[direction];

  return (
    <Card size="sm" className="gap-2 px-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">{label}</h3>
        <Icon className="size-4 text-muted-foreground" aria-hidden />
      </div>
      <p className="text-2xl font-semibold tabular-nums tracking-tight">
        {href ? (
          <Link href={href} className="rounded-sm hover:underline" aria-label={`${value} ${label}, view the underlying list`}>
            {value}
          </Link>
        ) : (
          value
        )}
      </p>
      {detail ? <p className="text-xs tabular-nums text-muted-foreground">{detail}</p> : null}
      {changePercent === null ? (
        <p className="text-xs text-muted-foreground">{trendNote ?? "No comparison available."}</p>
      ) : (
        <p className="flex flex-wrap items-center gap-x-1.5 text-xs">
          <span className={cn("inline-flex items-center gap-0.5 font-medium tabular-nums", TONE_CLASS[tone])}>
            <TrendIcon className="size-3.5" aria-hidden />
            {formatChange(changePercent)}
          </span>
          <span className="text-muted-foreground" aria-hidden>
            {comparison}
          </span>
          <span className="sr-only">{trendDescription({ changePercent }, comparison)}</span>
        </p>
      )}
    </Card>
  );
}

export function MetricCardSkeleton() {
  return (
    <Card size="sm" className="gap-3 px-4" aria-hidden>
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-8 w-28" />
      <Skeleton className="h-3.5 w-36" />
    </Card>
  );
}
