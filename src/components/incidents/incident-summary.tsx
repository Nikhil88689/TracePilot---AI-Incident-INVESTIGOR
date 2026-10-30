import { CheckCircle2, Flame, Siren, type LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { formatNumber } from "@/lib/dashboard/format";
import type { IncidentCounts } from "@/lib/incidents/types";
import { cn } from "@/lib/utils";

const ITEMS: { key: keyof Pick<IncidentCounts, "unresolved" | "critical" | "recentlyResolved">; label: string; hint: string; icon: LucideIcon; tone: string }[] = [
  { key: "unresolved", label: "Unresolved", hint: "Open or being investigated", icon: Siren, tone: "text-warning" },
  { key: "critical", label: "Critical", hint: "Unresolved, highest severity", icon: Flame, tone: "text-destructive" },
  { key: "recentlyResolved", label: "Recently resolved", hint: "In the last 7 days", icon: CheckCircle2, tone: "text-success" },
];

export function IncidentSummary({ counts }: { counts: IncidentCounts }) {
  return (
    <section aria-label="Incident summary" className="grid gap-4 sm:grid-cols-3">
      {ITEMS.map(({ key, label, hint, icon: Icon, tone }) => (
        <Card key={key} size="sm" className="gap-1 px-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">{label}</h2>
            <Icon className={cn("size-4", tone)} aria-hidden />
          </div>
          <p className="text-2xl font-semibold tabular-nums tracking-tight">{formatNumber(counts[key])}</p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </Card>
      ))}
    </section>
  );
}
