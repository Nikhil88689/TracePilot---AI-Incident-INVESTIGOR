"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { Project } from "@/lib/dashboard/types";
import { useStoredFlag } from "@/lib/use-stored-flag";
import { cn } from "@/lib/utils";
import { DemoBanner } from "@/components/demo/demo-banner";
import { DemoDialog } from "@/components/demo/demo-dialog";
import { CommandMenu } from "./command-menu";
import { HelpDialog } from "./help-dialog";
import { ShellProvider } from "./shell-context";
import { SidebarContent } from "./sidebar";
import { TestEventDialog } from "./test-event-dialog";
import { Topbar } from "./topbar";

const COLLAPSE_KEY = "tracepilot.sidebar.collapsed";

type Props = {
  children: ReactNode;
  projects: Project[];
  unresolvedByProject: Record<string, number>;
  userEmail: string;
};

export function AppShell({ children, projects, unresolvedByProject, userEmail }: Props) {
  const [collapsed, toggleCollapsed] = useStoredFlag(COLLAPSE_KEY);
  const [navOpen, setNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [testEventOpen, setTestEventOpen] = useState(false);
  const [demoOpen, setDemoOpen] = useState(false);

  const value = useMemo(
    () => ({
      projects,
      unresolvedByProject,
      userEmail,
      demoProjectId: projects.find((p) => p.isDemo)?.id ?? null,
      openDemo: () => setDemoOpen(true),
      openTestEvent: () => setTestEventOpen(true),
      openHelp: () => setHelpOpen(true),
      openSearch: () => setSearchOpen(true),
    }),
    [projects, unresolvedByProject, userEmail],
  );

  return (
    <ShellProvider value={value}>
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>

      <div className="flex min-h-screen">
        <aside
          aria-label="Sidebar"
          className={cn(
            "sticky top-0 hidden h-screen shrink-0 border-r border-sidebar-border bg-sidebar md:block",
            collapsed ? "w-16" : "w-64",
          )}
        >
          <SidebarContent collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
        </aside>

        <Sheet open={navOpen} onOpenChange={setNavOpen}>
          <SheetContent side="left" className="w-72 max-w-[85vw] gap-0 bg-sidebar p-0">
            <SheetHeader className="sr-only">
              <SheetTitle>Navigation</SheetTitle>
              <SheetDescription>Main application navigation</SheetDescription>
            </SheetHeader>
            <SidebarContent onNavigate={() => setNavOpen(false)} />
          </SheetContent>
        </Sheet>

        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar onOpenNav={() => setNavOpen(true)} />
          <main id="main" tabIndex={-1} className="flex-1 px-4 py-6 outline-none md:px-6">
            <div className="mx-auto w-full max-w-[1440px]">
              <DemoBanner />
              {children}
            </div>
          </main>
        </div>
      </div>

      <CommandMenu open={searchOpen} onOpenChange={setSearchOpen} />
      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
      <TestEventDialog open={testEventOpen} onOpenChange={setTestEventOpen} />
      <DemoDialog open={demoOpen} onOpenChange={setDemoOpen} />
    </ShellProvider>
  );
}
