"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

/**
 * Filters live in the URL, never in component state: refresh, back/forward, and shared links all
 * reproduce the same view, and the server renders the result. Any filter change resets paging.
 */
export function useUrlFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const navigate = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(searchParams.toString());
      mutate(next);
      next.delete("page");
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  /** Sets (or, for an empty value, removes) the given keys. */
  const update = useCallback(
    (patch: Record<string, string>) =>
      navigate((next) => {
        for (const [key, value] of Object.entries(patch)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
      }),
    [navigate],
  );

  /** Removes the given keys, leaving everything else (project scope, sort) in place. */
  const clear = useCallback((keys: string[]) => navigate((next) => keys.forEach((k) => next.delete(k))), [navigate]);

  return { update, clear };
}
