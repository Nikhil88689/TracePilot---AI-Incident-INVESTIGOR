"use client";

import { Menu } from "lucide-react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { AccountMenu } from "./account-menu";
import { Breadcrumbs } from "./breadcrumbs";
import { CommandMenuTrigger } from "./command-menu";
import { RefreshButton } from "./refresh-button";
import { TimeRangeSelector } from "./time-range-selector";

export function Topbar({ onOpenNav }: { onOpenNav: () => void }) {
  // The 1h/24h/7d window only drives the dashboard; lists have their own date filter.
  const showRange = usePathname() === "/dashboard";

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background/95 px-3 backdrop-blur-none sm:gap-3 md:px-6">
      <Button
        variant="ghost"
        size="icon"
        onClick={onOpenNav}
        aria-label="Open navigation"
        className="shrink-0 md:hidden"
      >
        <Menu className="size-5" aria-hidden />
      </Button>

      <div className="min-w-0 flex-1">
        <Breadcrumbs />
      </div>

      {showRange ? <TimeRangeSelector /> : null}
      <CommandMenuTrigger />
      <RefreshButton />
      <AccountMenu className="hidden md:inline-flex" />
    </header>
  );
}
