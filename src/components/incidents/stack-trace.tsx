"use client";

import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import { CopyButton } from "@/components/common/copy-button";
import { cn } from "@/lib/utils";

type Props = { trace: string | null; defaultOpen?: boolean; title?: string };

/** Expandable, monospace stack trace with a copy control. Collapsed, it previews the first line. */
export function StackTrace({ trace, defaultOpen = false, title = "Stack trace" }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();

  if (!trace) {
    return <p className="text-sm text-muted-foreground">No stack trace was captured for this event.</p>;
  }
  const lines = trace.split("\n");

  return (
    <div className="rounded-md border border-border bg-background">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 items-center gap-1.5 rounded-sm text-sm font-medium"
        >
          <ChevronRight className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")} aria-hidden />
          {title}
          <span className="font-normal text-muted-foreground">({lines.length} {lines.length === 1 ? "line" : "lines"})</span>
        </button>
        <CopyButton value={trace} label="Copy" />
      </div>
      <pre
        id={id}
        tabIndex={0}
        aria-label={`${title} text`}
        className={cn(
          "overflow-auto border-t border-border px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre",
          open ? "max-h-96" : "max-h-[2.75rem] overflow-hidden text-muted-foreground",
        )}
      >
        {open ? trace : lines[0]}
      </pre>
    </div>
  );
}
