"use client";

import { useCallback, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();

function subscribe(callback: () => void) {
  listeners.add(callback);
  window.addEventListener("storage", callback);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", callback);
  };
}

function read(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/** Boolean preference backed by localStorage. Renders `false` on the server, then syncs. */
export function useStoredFlag(key: string): [boolean, () => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => false,
  );

  const toggle = useCallback(() => {
    try {
      window.localStorage.setItem(key, read(key) ? "0" : "1");
    } catch {
      /* non-critical preference */
    }
    listeners.forEach((l) => l());
  }, [key]);

  return [value, toggle];
}
