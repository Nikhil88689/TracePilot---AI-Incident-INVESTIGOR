"use client";

import Link from "next/link";
import { useEffect } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";

/**
 * Error boundary for every signed-in page. The shell (sidebar, header) stays; only the page area shows this.
 * Without it an uncaught render error falls through to Next's unstyled default. Only the opaque digest is logged
 * client-side; the message may contain data, so it is neither logged nor shown.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[app] render error", error.digest ?? "no digest");
  }, [error]);

  return (
    <div role="alert" className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-3 text-center">
      <TriangleAlert className="size-8 text-destructive" aria-hidden />
      <h1 className="text-lg font-semibold">This page couldn&apos;t load</h1>
      <p className="text-sm text-muted-foreground">
        Something went wrong while loading this page. Your data is not affected. Try again, or go back to the overview.
      </p>
      {error.digest ? <p className="font-mono text-xs text-muted-foreground">Reference: {error.digest}</p> : null}
      <div className="flex gap-2">
        <Button onClick={reset}>
          <RotateCcw aria-hidden /> Try again
        </Button>
        <Link href="/dashboard" className={buttonVariants({ variant: "outline" })}>
          Overview
        </Link>
      </div>
    </div>
  );
}
