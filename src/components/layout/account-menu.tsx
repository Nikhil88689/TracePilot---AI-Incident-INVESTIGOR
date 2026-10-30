"use client";

import Link from "next/link";
import { useTransition } from "react";
import { BookOpen, LogOut, Settings } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOut } from "@/lib/auth/actions";
import { initialsFromEmail } from "@/lib/dashboard/format";
import { cn } from "@/lib/utils";
import { useDashboardParams, useShell } from "./shell-context";

type Props = {
  /** "sidebar" shows the email next to the avatar; "compact" is avatar only. */
  variant?: "sidebar" | "compact";
  collapsed?: boolean;
  className?: string;
};

export function AccountMenu({ variant = "compact", collapsed = false, className }: Props) {
  const { userEmail, openHelp } = useShell();
  const { hrefFor } = useDashboardParams();
  const [pending, startTransition] = useTransition();
  const showEmail = variant === "sidebar" && !collapsed;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            aria-label={`Account menu for ${userEmail}`}
            className={cn(
              showEmail ? "h-10 w-full justify-start gap-2.5 px-2" : "size-8 rounded-full p-0",
              variant === "sidebar" && collapsed && "mx-auto",
              className,
            )}
          />
        }
      >
        <Avatar className="size-7">
          <AvatarFallback className="bg-accent text-xs font-medium text-primary">
            {initialsFromEmail(userEmail)}
          </AvatarFallback>
        </Avatar>
        {showEmail ? <span className="min-w-0 flex-1 truncate text-left text-sm">{userEmail}</span> : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side={variant === "sidebar" ? "top" : "bottom"} className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="truncate font-normal text-muted-foreground">{userEmail}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href={hrefFor("/settings")} />}>
          <Settings aria-hidden /> Project settings
        </DropdownMenuItem>
        <DropdownMenuItem onClick={openHelp}>
          <BookOpen aria-hidden /> Documentation
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={pending}
          onClick={() => startTransition(() => signOut())}
        >
          <LogOut aria-hidden /> {pending ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
