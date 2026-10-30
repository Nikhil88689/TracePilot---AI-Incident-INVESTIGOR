"use client";

import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useDebouncedField } from "./use-debounced-field";

type Props = {
  /** The value currently applied in the URL. */
  value: string;
  label: string;
  placeholder: string;
  onCommit: (value: string) => void;
  delayMs?: number;
};

/** Search input that applies itself to the URL after a pause in typing, with a clear button. */
export function SearchBox({ value, label, placeholder, onCommit, delayMs }: Props) {
  const { draft, setDraft, clear, focusProps } = useDebouncedField(value, onCommit, delayMs);

  return (
    <div className="relative">
      <label htmlFor="search-box" className="sr-only">
        {label}
      </label>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input
        id="search-box"
        type="text"
        role="searchbox"
        value={draft}
        maxLength={100}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && draft) clear();
        }}
        className="h-8 pr-8 pl-8"
        {...focusProps}
      />
      {draft ? (
        <button
          type="button"
          onClick={clear}
          aria-label="Clear search"
          className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
