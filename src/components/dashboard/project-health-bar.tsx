import type { ProjectHealth, HealthLevel } from "@/lib/dashboard/health";
import { cn } from "@/lib/utils";

const DOT: Record<HealthLevel, string> = {
  healthy: "bg-success",
  degraded: "bg-warning",
  critical: "bg-destructive",
  idle: "bg-muted-foreground",
};

const TEXT: Record<HealthLevel, string> = {
  healthy: "text-success",
  degraded: "text-warning",
  critical: "text-destructive",
  idle: "text-muted-foreground",
};

type Props = { health: ProjectHealth; projectName: string; generatedAt: string };

export function ProjectHealthBar({ health, projectName, generatedAt }: Props) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between">
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5" role="status">
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[health.level])} />
        <span className="font-medium">{projectName}</span>
        <span className={cn("font-medium", TEXT[health.level])}>{health.label}</span>
        <span className="text-muted-foreground">{health.detail}</span>
      </p>
      <p className="shrink-0 text-xs text-muted-foreground">
        Updated{" "}
        <time dateTime={generatedAt} className="tabular-nums">
          {new Date(generatedAt).toLocaleTimeString("en-US", { hour12: false, timeZone: "UTC" })} UTC
        </time>
      </p>
    </div>
  );
}
