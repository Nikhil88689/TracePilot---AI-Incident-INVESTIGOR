"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function RefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant="outline"
      size="icon"
      aria-label={pending ? "Refreshing data" : "Refresh data"}
      aria-busy={pending}
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      <RefreshCw className={pending ? "size-4 animate-spin" : "size-4"} aria-hidden />
    </Button>
  );
}
