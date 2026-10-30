"use client";

import { FilterX } from "lucide-react";
import { SearchBox } from "@/components/common/search-box";
import { useDebouncedField } from "@/components/common/use-debounced-field";
import { useUrlFilters } from "@/components/common/use-url-filters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { EVENT_LEVELS, SINCE_LABELS, SINCE_VALUES } from "@/lib/incidents/params";
import type { EventFilterOptions } from "@/lib/incidents/types";

export type EventFilterValues = { q: string; type: string; level: string; endpoint: string; since: string; project: string };
export const EVENT_FILTER_KEYS = ["q", "type", "level", "endpoint", "since"] as const;

type Props = {
  values: EventFilterValues;
  options: EventFilterOptions;
  projects: { id: string; name: string }[];
};

/** Free-text endpoint filter that applies after a pause, with suggestions from the endpoints actually seen. */
function EndpointInput({ value, suggestions, onCommit }: { value: string; suggestions: string[]; onCommit: (v: string) => void }) {
  const { draft, setDraft, focusProps } = useDebouncedField(value, onCommit);
  return (
    <>
      <Label htmlFor="f-endpoint" className="sr-only">Endpoint</Label>
      <Input id="f-endpoint" list="endpoint-suggestions" value={draft} maxLength={300} placeholder="Endpoint contains…" autoComplete="off" className="h-8" onChange={(e) => setDraft(e.target.value)} {...focusProps} />
      <datalist id="endpoint-suggestions">
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </>
  );
}

export function EventFilters({ values, options, projects }: Props) {
  const { update, clear } = useUrlFilters();
  const active = values.q !== "" || values.type !== "" || values.level !== "all" || values.endpoint !== "" || values.since !== "all";
  const set = (key: string, off = "all") => (e: React.ChangeEvent<HTMLSelectElement>) => update({ [key]: e.target.value === off ? "" : e.target.value });

  return (
    <form role="search" aria-label="Filter events" className="space-y-2 p-3" onSubmit={(e) => e.preventDefault()}>
      <div className="flex flex-col gap-2 xl:flex-row xl:items-center">
        <div className="xl:max-w-xs xl:flex-1">
          <SearchBox value={values.q} label="Search events" placeholder="Search message, type, endpoint…" onCommit={(q) => update({ q })} />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:flex">
          <div>
            <Label htmlFor="f-project" className="sr-only">Project</Label>
            <NativeSelect id="f-project" value={values.project || "all"} onChange={(e) => update({ project: e.target.value === "all" ? "" : e.target.value })}>
              <option value="all">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </NativeSelect>
          </div>
          <div>
            <Label htmlFor="f-type" className="sr-only">Event type</Label>
            <NativeSelect id="f-type" value={values.type || "all"} onChange={set("type")}>
              <option value="all">All types</option>
              {values.type && !options.eventTypes.includes(values.type) ? <option value={values.type}>{values.type}</option> : null}
              {options.eventTypes.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </NativeSelect>
          </div>
          <div>
            <Label htmlFor="f-level" className="sr-only">Level</Label>
            <NativeSelect id="f-level" value={values.level} onChange={set("level")}>
              <option value="all">All levels</option>
              {EVENT_LEVELS.map((l) => (
                <option key={l} value={l}>{l[0].toUpperCase() + l.slice(1)}</option>
              ))}
            </NativeSelect>
          </div>
          <div>
            <Label htmlFor="f-since" className="sr-only">Time</Label>
            <NativeSelect id="f-since" value={values.since} onChange={set("since")}>
              {SINCE_VALUES.map((s) => (
                <option key={s} value={s}>{s === "all" ? "Any time" : SINCE_LABELS[s]}</option>
              ))}
            </NativeSelect>
          </div>
          <div className="col-span-2 sm:col-span-2 xl:col-span-1">
            <EndpointInput value={values.endpoint} suggestions={options.endpoints} onCommit={(endpoint) => update({ endpoint })} />
          </div>
        </div>
        {active ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => clear([...EVENT_FILTER_KEYS])}>
            <FilterX aria-hidden /> Reset
          </Button>
        ) : null}
      </div>
    </form>
  );
}

export function ClearEventFilters() {
  const { clear } = useUrlFilters();
  return (
    <Button type="button" variant="outline" size="sm" onClick={() => clear([...EVENT_FILTER_KEYS])}>
      Clear filters
    </Button>
  );
}
