import Link from "next/link";
import { Activity } from "lucide-react";
import { cn } from "@/lib/utils";

export function Logo({
  className,
  href = "/",
  iconOnly = false,
}: {
  className?: string;
  href?: string;
  iconOnly?: boolean;
}) {
  return (
    <Link
      href={href}
      aria-label="TracePilot home"
      className={cn("flex items-center gap-2 rounded-md font-semibold tracking-tight", className)}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <Activity className="size-4" aria-hidden />
      </span>
      {iconOnly ? null : <span>TracePilot</span>}
    </Link>
  );
}
