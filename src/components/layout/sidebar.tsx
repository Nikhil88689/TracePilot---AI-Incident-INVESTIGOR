"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { AccountMenu } from "./account-menu";
import { Logo } from "./logo";
import { NAV_ITEMS } from "./nav-items";
import { ProjectSelector } from "./project-selector";
import { useDashboardParams, useShell } from "./shell-context";

type Props = {
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** Called after a navigation/help action, so the mobile drawer can close. */
  onNavigate?: () => void;
};

export function SidebarContent({ collapsed = false, onToggleCollapsed, onNavigate }: Props) {
  const pathname = usePathname();
  const { unresolvedByProject, projects, openHelp } = useShell();
  const { projectId, hrefFor } = useDashboardParams();
  const unresolved = projectId
    ? (unresolvedByProject[projectId] ?? 0)
    : // "All projects" never includes the simulated demo, so demo data cannot inflate real counts.
      projects.filter((p) => !p.isDemo).reduce((sum, p) => sum + (unresolvedByProject[p.id] ?? 0), 0);

  return (
    <div className="flex h-full flex-col gap-4 p-3">
      <div className={cn("flex h-8 items-center", collapsed ? "justify-center" : "px-1")}>
        <Logo href={hrefFor("/dashboard")} iconOnly={collapsed} />
      </div>

      <ProjectSelector collapsed={collapsed} />

      <nav aria-label="Primary" className="flex flex-1 flex-col gap-0.5">
        {NAV_ITEMS.map(({ href, label, icon: Icon, badge }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          const count = badge === "unresolved" ? unresolved : 0;
          const link = (
            <Link
              href={hrefFor(href)}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              aria-label={count > 0 ? `${label}, ${count} unresolved` : label}
              className={cn(
                "relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                active && "bg-primary/10 font-medium text-foreground hover:bg-primary/15",
                collapsed && "justify-center px-0",
              )}
            >
              {active ? (
                <span aria-hidden className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-primary" />
              ) : null}
              <Icon className={cn("size-4 shrink-0", active && "text-primary")} aria-hidden />
              {collapsed ? null : <span className="flex-1 truncate">{label}</span>}
              {count > 0 ? (
                <span
                  aria-hidden
                  className={cn(
                    "rounded-full bg-destructive/15 px-1.5 text-xs font-medium tabular-nums text-destructive",
                    collapsed && "absolute top-0.5 right-1 px-1 text-[10px] leading-4",
                  )}
                >
                  {count}
                </span>
              ) : null}
            </Link>
          );

          if (!collapsed) return <div key={href}>{link}</div>;
          return (
            <Tooltip key={href}>
              <TooltipTrigger render={<div />}>{link}</TooltipTrigger>
              <TooltipContent side="right">{label}</TooltipContent>
            </Tooltip>
          );
        })}
      </nav>

      <div className="flex flex-col gap-0.5 border-t border-sidebar-border pt-3">
        <Button
          variant="ghost"
          onClick={() => {
            onNavigate?.();
            openHelp();
          }}
          aria-label="Documentation and help"
          className={cn("h-9 justify-start gap-2.5 px-2.5 text-sidebar-foreground", collapsed && "justify-center px-0")}
        >
          <BookOpen className="size-4" aria-hidden />
          {collapsed ? null : "Documentation"}
        </Button>

        {onToggleCollapsed ? (
          <Button
            variant="ghost"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn("h-9 justify-start gap-2.5 px-2.5 text-sidebar-foreground", collapsed && "justify-center px-0")}
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4" aria-hidden />
            ) : (
              <PanelLeftClose className="size-4" aria-hidden />
            )}
            {collapsed ? null : "Collapse"}
          </Button>
        ) : null}

        <AccountMenu variant="sidebar" collapsed={collapsed} className="mt-1" />
      </div>
    </div>
  );
}
