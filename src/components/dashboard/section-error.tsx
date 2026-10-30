"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Error state for ONE dashboard section. A failed query in one section must not blank the page, so
 * each section renders this on its own and offers a retry that re-fetches the route.
 */
export function SectionError({ title, className }: { title: string; className?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div role="alert" className={cn("flex flex-col items-center justify-center gap-2 px-4 py-8 text-center", className)}>
      <TriangleAlert className="size-6 text-destructive" aria-hidden />
      <p className="text-sm font-medium">{title} could not be loaded</p>
      <p className="max-w-xs text-xs text-muted-foreground">This is usually temporary. Nothing else on this page was affected.</p>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => startTransition(() => router.refresh())}>
        {pending ? <Loader2 className="animate-spin" aria-hidden /> : <RotateCcw aria-hidden />}
        {pending ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}
