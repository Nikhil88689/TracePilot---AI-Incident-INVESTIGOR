import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { SEVERITY_LABELS, SeverityBadge, StatusBadge } from "@/components/dashboard/status-badges";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber, formatRelative } from "@/lib/dashboard/format";
import type { IncidentSort, SortDir } from "@/lib/incidents/params";
import type { IncidentSummary } from "@/lib/incidents/types";
import { cn } from "@/lib/utils";
import { ClickableRow } from "./clickable-row";

export { SEVERITY_LABELS };

type Column = { key: IncidentSort; label: string; className?: string; align?: "right" };

const COLUMNS: Column[] = [
  { key: "title", label: "Incident" },
  { key: "severity", label: "Severity" },
  { key: "status", label: "Status" },
  { key: "occurrences", label: "Occurrences", className: "hidden sm:table-cell", align: "right" },
  { key: "first_seen", label: "First seen", className: "hidden xl:table-cell" },
  { key: "last_seen", label: "Last seen", className: "hidden sm:table-cell" },
  { key: "endpoint", label: "Endpoint", className: "hidden lg:table-cell" },
];

type Props = {
  items: IncidentSummary[];
  /** Server timestamp (ISO) so relative times match between server and client renders. */
  now: string;
  /** Preserved query string for detail links, e.g. "?project=…". */
  detailQuery?: string;
  /** When provided, headers become links that change the server-side sort. */
  sort?: { key: IncidentSort; dir: SortDir; hrefFor: (key: IncidentSort) => string };
};

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <ArrowUpDown className="size-3 opacity-50" aria-hidden />;
  return dir === "asc" ? <ArrowUp className="size-3" aria-hidden /> : <ArrowDown className="size-3" aria-hidden />;
}

/** Server-rendered table. Sorting is link-based (URL state), so there is no client-side data handling. */
export function IncidentTable({ items, now, detailQuery = "", sort }: Props) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {COLUMNS.map((col) => {
            const active = sort?.key === col.key;
            return (
              <TableHead
                key={col.key}
                scope="col"
                aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : sort ? "none" : undefined}
                className={cn("h-9 px-3 text-xs", col.className, col.align === "right" && "text-right")}
              >
                {sort ? (
                  <Link
                    href={sort.hrefFor(col.key)}
                    scroll={false}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
                      active && "text-foreground",
                    )}
                  >
                    {col.label}
                    <SortIcon active={active} dir={sort.dir} />
                  </Link>
                ) : (
                  <span className="font-medium text-muted-foreground">{col.label}</span>
                )}
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((incident) => {
          const href = `/incidents/${incident.id}${detailQuery}`;
          return (
            <ClickableRow key={incident.id} href={href}>
              <TableCell className="max-w-0 px-3 py-2 whitespace-normal sm:max-w-md">
                <Link href={href} className="line-clamp-2 rounded-sm font-medium hover:underline">
                  {incident.title}
                </Link>
                <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground lg:hidden">
                  {incident.endpoint ?? "—"}
                  <span className="sm:hidden"> · {formatRelative(incident.lastSeenAt, now)}</span>
                </span>
                <span className="mt-0.5 hidden truncate text-xs text-muted-foreground lg:block">
                  {incident.projectName} · {incident.environment}
                </span>
              </TableCell>
              <TableCell className="px-3 py-2">
                <SeverityBadge severity={incident.severity} />
              </TableCell>
              <TableCell className="px-3 py-2">
                <StatusBadge status={incident.status} />
              </TableCell>
              <TableCell className="hidden px-3 py-2 text-right tabular-nums sm:table-cell">
                {formatNumber(incident.occurrenceCount)}
              </TableCell>
              <TableCell className="hidden px-3 py-2 whitespace-nowrap text-muted-foreground xl:table-cell">
                <time dateTime={incident.firstSeenAt} title={new Date(incident.firstSeenAt).toUTCString()}>
                  {formatRelative(incident.firstSeenAt, now)}
                </time>
              </TableCell>
              <TableCell className="hidden px-3 py-2 whitespace-nowrap text-muted-foreground sm:table-cell">
                <time dateTime={incident.lastSeenAt} title={new Date(incident.lastSeenAt).toUTCString()}>
                  {formatRelative(incident.lastSeenAt, now)}
                </time>
              </TableCell>
              <TableCell className="hidden max-w-[16rem] truncate px-3 py-2 font-mono text-xs text-muted-foreground lg:table-cell">
                {incident.endpoint ?? "—"}
              </TableCell>
            </ClickableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function IncidentTableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-hidden>
      <div className="flex gap-2 border-b border-border p-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-8 w-32" />
      </div>
      <div className="space-y-3 p-3">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    </div>
  );
}
