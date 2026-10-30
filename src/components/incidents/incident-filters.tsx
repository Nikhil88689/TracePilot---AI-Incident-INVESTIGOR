"use client";

import { FilterX } from "lucide-react";
import { SearchBox } from "@/components/common/search-box";
import { useUrlFilters } from "@/components/common/use-url-filters";
import { SEVERITY_LABELS } from "@/components/dashboard/status-badges";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { INCIDENT_STATUSES, SEVERITIES } from "@/lib/dashboard/types";
import { SINCE_LABELS, SINCE_VALUES } from "@/lib/incidents/params";
import { STATUS_LABELS } from "@/lib/incidents/transitions";
import { ENVIRONMENT_LABELS, ENVIRONMENTS } from "@/lib/projects/schemas";

export type IncidentFilterValues = { q: string; status: string; severity: string; env: string; since: string };

export const INCIDENT_FILTER_KEYS = ["q", "status", "severity", "env", "since"] as const;

export function IncidentFilters({ values }: { values: IncidentFilterValues }) {
  const { update, clear } = useUrlFilters();
  const active = values.q !== "" || values.status !== "all" || values.severity !== "all" || values.env !== "all" || values.since !== "all";

  // "all" is the default for every select, so it is removed from the URL rather than stored.
  const set = (key: string) => (e: React.ChangeEvent<HTMLSelectElement>) => update({ [key]: e.target.value === "all" ? "" : e.target.value });

  return (
    <form role="search" aria-label="Filter incidents" className="space-y-2 p-3" onSubmit={(e) => e.preventDefault()}>
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="lg:max-w-sm lg:flex-1">
          <SearchBox value={values.q} label="Search incidents" placeholder="Search title or endpoint…" onCommit={(q) => update({ q })} />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:flex">
          <div>
            <Label htmlFor="f-status" className="sr-only">Status</Label>
            <NativeSelect id="f-status" value={values.status} onChange={set("status")}>
              <option value="all">All statuses</option>
              {INCIDENT_STATUSES.map((s) => (
                <option key={s} value={s}>{STATUS_LABELS[s]}</option>
              ))}
            </NativeSelect>
          </div>
          <div>
            <Label htmlFor="f-severity" className="sr-only">Severity</Label>
            <NativeSelect id="f-severity" value={values.severity} onChange={set("severity")}>
              <option value="all">All severities</option>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>{SEVERITY_LABELS[s]}</option>
              ))}
            </NativeSelect>
          </div>
          <div>
            <Label htmlFor="f-env" className="sr-only">Environment</Label>
            <NativeSelect id="f-env" value={values.env} onChange={set("env")}>
              <option value="all">All environments</option>
              {ENVIRONMENTS.map((e) => (
                <option key={e} value={e}>{ENVIRONMENT_LABELS[e].label}</option>
              ))}
            </NativeSelect>
          </div>
          <div>
            <Label htmlFor="f-since" className="sr-only">Last seen</Label>
            <NativeSelect id="f-since" value={values.since} onChange={set("since")}>
              {SINCE_VALUES.map((s) => (
                <option key={s} value={s}>{s === "all" ? "Any time" : `Seen: ${SINCE_LABELS[s].toLowerCase()}`}</option>
              ))}
            </NativeSelect>
          </div>
        </div>
        {active ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => clear([...INCIDENT_FILTER_KEYS])}>
            <FilterX aria-hidden /> Reset
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/** Used by empty states: clears all filters while keeping project scope and sorting. */
export function ClearIncidentFilters() {
  const { clear } = useUrlFilters();
  return (
    <Button type="button" variant="outline" size="sm" onClick={() => clear([...INCIDENT_FILTER_KEYS])}>
      Clear filters
    </Button>
  );
}
