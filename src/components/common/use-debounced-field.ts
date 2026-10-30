"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A text field whose value is applied to the URL after a pause in typing.
 *
 * - `value` is what the URL currently says. While the field is focused the user's draft always
 *   wins, so a slow navigation can never overwrite characters they are still typing.
 * - When the field is not focused, a changed `value` (Reset, a "Clear filters" link, back/forward)
 *   is adopted immediately.
 */
export function useDebouncedField(value: string, onCommit: (next: string) => void, delayMs = 300) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  const [focused, setFocused] = useState(false);

  // Adjusting state while rendering is React's supported way to sync state to a changed prop.
  if (value !== seen) {
    setSeen(value);
    if (!focused) setDraft(value);
  }

  // Always call the latest callback without restarting the timer when its identity changes.
  const commit = useRef(onCommit);
  useEffect(() => {
    commit.current = onCommit;
  });

  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => commit.current(draft), delayMs);
    return () => clearTimeout(timer);
  }, [draft, value, delayMs]);

  return {
    draft,
    setDraft,
    clear: () => {
      setDraft("");
      commit.current("");
    },
    focusProps: { onFocus: () => setFocused(true), onBlur: () => setFocused(false) },
  };
}
