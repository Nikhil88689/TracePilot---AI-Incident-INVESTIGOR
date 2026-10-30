"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { DEFAULT_RANGE, parseRange, resolveProjectId } from "@/lib/dashboard/params";
import type { Project, TimeRange } from "@/lib/dashboard/types";

type ShellContextValue = {
  projects: Project[];
  unresolvedByProject: Record<string, number>;
  userEmail: string;
  /** The user's demo project id, if they have created one. */
  demoProjectId: string | null;
  openDemo: () => void;
  openTestEvent: () => void;
  openHelp: () => void;
  openSearch: () => void;
};

const ShellContext = createContext<ShellContextValue | null>(null);

export function ShellProvider({ value, children }: { value: ShellContextValue; children: ReactNode }) {
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used inside <ShellProvider>");
  return ctx;
}

/** Project + time range live in the URL so views are shareable and survive refresh. */
export function useDashboardParams() {
  const { projects } = useShell();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const range = parseRange(searchParams.get("range"));
  const projectId = resolveProjectId(searchParams.get("project"), projects);
  /** The selected project, or null when viewing all projects. */
  const project = projects.find((p) => p.id === projectId) ?? null;

  const hrefFor = useCallback(
    (path: string, overrides: { range?: TimeRange; project?: string } = {}) => {
      const params = new URLSearchParams();
      const nextProject = overrides.project !== undefined ? overrides.project : projectId;
      if (nextProject) params.set("project", nextProject);
      const nextRange = overrides.range ?? range;
      if (nextRange !== DEFAULT_RANGE) params.set("range", nextRange);
      return `${path}?${params.toString()}`;
    },
    [projectId, range],
  );

  return useMemo(
    () => ({
      range,
      projectId,
      project,
      hrefFor,
      setRange: (next: TimeRange) => router.replace(hrefFor(pathname, { range: next }), { scroll: false }),
      setProject: (next: string) => router.replace(hrefFor(pathname, { project: next }), { scroll: false }),
    }),
    [range, projectId, project, hrefFor, router, pathname],
  );
}
