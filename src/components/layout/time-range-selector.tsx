"use client";

import { useTransition } from "react";
import { Loader2 } from "lucide-react";
import { RANGE_LABELS } from "@/lib/dashboard/params";
import { TIME_RANGES } from "@/lib/dashboard/types";
import { cn } from "@/lib/utils";
import { useDashboardParams } from "./shell-context";

const SHORT: Record<(typeof TIME_RANGES)[number], string> = { "1h": "1h", "24h": "24h", "7d": "7d" };

/** Segmented control. Arrow keys move between options (roving tabindex), per the radiogroup pattern. */
export function TimeRangeSelector() {
  const { range, setRange: apply } = useDashboardParams();
  // The server re-renders for a new range; show that work is in flight instead of looking frozen.
  const [pending, startTransition] = useTransition();
  const setRange = (next: (typeof TIME_RANGES)[number]) => startTransition(() => apply(next));

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const dir =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!dir) return;
    event.preventDefault();
    const next = TIME_RANGES[(TIME_RANGES.indexOf(range) + dir + TIME_RANGES.length) % TIME_RANGES.length];
    setRange(next);
    // Move focus to the newly selected option once it re-renders.
    requestAnimationFrame(() =>
      (event.currentTarget.querySelector(`[data-range="${next}"]`) as HTMLElement | null)?.focus(),
    );
  }

  return (
    <div className="flex items-center gap-2">
      {pending ? (
        <Loader2
          className="size-3.5 animate-spin text-muted-foreground"
          role="status"
          aria-label="Updating"
        />
      ) : null}
      <div
        aria-busy={pending}
        role="radiogroup"
        aria-label="Time range"
        onKeyDown={onKeyDown}
        className="inline-flex h-8 items-center rounded-md border border-border bg-card p-0.5"
      >
        {TIME_RANGES.map((value) => {
          const selected = value === range;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`Last ${RANGE_LABELS[value]}`}
              data-range={value}
              tabIndex={selected ? 0 : -1}
              onClick={() => setRange(value)}
              className={cn(
                "h-7 rounded-[5px] px-2.5 text-xs font-medium tabular-nums text-muted-foreground transition-colors hover:text-foreground",
                selected && "bg-primary/15 text-foreground",
              )}
            >
              {SHORT[value]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
