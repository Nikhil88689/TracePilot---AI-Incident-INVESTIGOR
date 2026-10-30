import { Badge } from "@/components/ui/badge";
import type { IncidentStatus, Severity } from "@/lib/dashboard/types";
import type { EventLevel } from "@/lib/incidents/types";
import { cn } from "@/lib/utils";

const SEVERITY_STYLES: Record<Severity, string> = {
  critical: "border-severity-critical/30 bg-severity-critical/10 text-severity-critical",
  high: "border-severity-high/30 bg-severity-high/10 text-severity-high",
  medium: "border-severity-medium/30 bg-severity-medium/10 text-severity-medium",
  low: "border-severity-low/30 bg-severity-low/10 text-severity-low",
};

const STATUS_STYLES: Record<IncidentStatus, string> = {
  open: "border-warning/30 bg-warning/10 text-warning",
  investigating: "border-info/30 bg-info/10 text-info",
  resolved: "border-success/30 bg-success/10 text-success",
};

const LABELS: Record<Severity | IncidentStatus, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  open: "Open",
  investigating: "Investigating",
  resolved: "Resolved",
};

/** Text label is always present, so meaning never depends on color alone. */
export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  return (
    <Badge variant="outline" className={cn(SEVERITY_STYLES[severity], className)}>
      {LABELS[severity]}
    </Badge>
  );
}

export function StatusBadge({ status, className }: { status: IncidentStatus; className?: string }) {
  return (
    <Badge variant="outline" className={cn(STATUS_STYLES[status], className)}>
      {LABELS[status]}
    </Badge>
  );
}

export const SEVERITY_LABELS = LABELS;

const LEVEL_STYLES: Record<EventLevel, string> = {
  fatal: "border-severity-critical/30 bg-severity-critical/10 text-severity-critical",
  error: "border-severity-high/30 bg-severity-high/10 text-severity-high",
  warning: "border-severity-medium/30 bg-severity-medium/10 text-severity-medium",
  info: "border-severity-low/30 bg-severity-low/10 text-severity-low",
  debug: "border-border bg-muted text-muted-foreground",
};

/** Event log level (distinct from an incident's severity). */
export function LevelBadge({ level, className }: { level: EventLevel; className?: string }) {
  return (
    <Badge variant="outline" className={cn(LEVEL_STYLES[level], className)}>
      {level[0].toUpperCase() + level.slice(1)}
    </Badge>
  );
}
