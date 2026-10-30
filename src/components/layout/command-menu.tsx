"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { FlaskConical, FolderKanban, Search, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { NAV_ITEMS } from "./nav-items";
import { useDashboardParams, useShell } from "./shell-context";

type Props = { open: boolean; onOpenChange: (open: boolean) => void };

export function CommandMenuTrigger() {
  const { openSearch } = useShell();
  return (
    <Button
      variant="outline"
      onClick={openSearch}
      aria-label="Search and commands"
      aria-keyshortcuts="Control+K Meta+K"
      className="size-8 justify-center px-0 text-muted-foreground sm:w-56 sm:justify-start sm:px-2.5"
    >
      <Search className="size-4" aria-hidden />
      <span className="hidden flex-1 text-left sm:inline">Search…</span>
      <kbd className="hidden rounded border border-border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground sm:inline">
        Ctrl K
      </kbd>
    </Button>
  );
}

export function CommandMenu({ open, onOpenChange }: Props) {
  const router = useRouter();
  const { projects, openTestEvent, demoProjectId, openDemo } = useShell();
  const { hrefFor, projectId } = useDashboardParams();

  // Global shortcut: Ctrl/Cmd + K toggles the palette.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  function run(action: () => void) {
    onOpenChange(false);
    action();
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search and commands"
      description="Jump to a page, switch project, or run an action."
    >
      <CommandInput placeholder="Search pages, projects, actions…" />
      <CommandList>
        <CommandEmpty>No matching results.</CommandEmpty>
        <CommandGroup heading="Pages">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
            <CommandItem key={href} value={`page ${label}`} onSelect={() => run(() => router.push(hrefFor(href)))}>
              <Icon aria-hidden /> {label}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Projects">
          <CommandItem value="project all projects" onSelect={() => run(() => router.push(hrefFor("/dashboard", { project: "" })))}>
            <FolderKanban aria-hidden /> All projects
            {!projectId ? <span className="ml-auto text-xs text-muted-foreground">current</span> : null}
          </CommandItem>
          {projects.map((p) => (
            <CommandItem
              key={p.id}
              value={`project ${p.name}`}
              onSelect={() => run(() => router.push(hrefFor("/dashboard", { project: p.id })))}
            >
              <FolderKanban aria-hidden /> {p.name}
              {p.id === projectId ? <span className="ml-auto text-xs text-muted-foreground">current</span> : null}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Actions">
          <CommandItem
            value="action try the demo"
            onSelect={() => run(() => (demoProjectId ? router.push(`/dashboard?project=${demoProjectId}`) : openDemo()))}
          >
            <FlaskConical aria-hidden /> {demoProjectId ? "Open the demo" : "Try the demo"}
          </CommandItem>
          <CommandItem value="action send test event" onSelect={() => run(openTestEvent)}>
            <Send aria-hidden /> Send test event
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
