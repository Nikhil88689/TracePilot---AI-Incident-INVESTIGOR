"use client";

import { ChevronsUpDown, FlaskConical, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useDashboardParams, useShell } from "./shell-context";

export function ProjectSelector({ collapsed = false }: { collapsed?: boolean }) {
  const { projects, demoProjectId, openDemo } = useShell();
  const { project, setProject } = useDashboardParams();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            aria-label={`Project: ${project?.name ?? "All projects"}. Change project`}
            className={cn("h-11 w-full justify-start gap-2.5 bg-card px-2", collapsed && "justify-center px-0")}
          />
        }
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent font-mono text-xs font-semibold uppercase text-primary">
          {project ? project.name.slice(0, 2) : <Layers className="size-4" aria-hidden />}
        </span>
        {collapsed ? null : (
          <>
            <span className="min-w-0 flex-1 text-left leading-tight">
              <span className="block truncate text-sm font-medium">{project?.name ?? "All projects"}</span>
              <span className="block truncate text-xs font-normal text-muted-foreground">
                {project ? (project.isDemo ? "SIMULATED DEMO" : project.environment) : `${projects.filter((p) => !p.isDemo).length} ${projects.filter((p) => !p.isDemo).length === 1 ? "project" : "projects"} (demo excluded)`}
              </span>
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Your projects</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={project?.id ?? "all"} onValueChange={(value) => setProject(value === "all" ? "" : String(value))}>
            <DropdownMenuRadioItem value="all" closeOnClick>All projects</DropdownMenuRadioItem>
            {projects.map((p) => (
              <DropdownMenuRadioItem key={p.id} value={p.id} closeOnClick>
                <span className="min-w-0">
                  <span className="block truncate">{p.name}</span>
                  <span className="block text-xs text-muted-foreground">{p.isDemo ? "simulated demo" : p.environment}</span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        {demoProjectId ? null : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={openDemo}>
              <FlaskConical aria-hidden /> Try the demo
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
