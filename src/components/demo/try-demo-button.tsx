"use client";

import Link from "next/link";
import { FlaskConical } from "lucide-react";
import { useShell } from "@/components/layout/shell-context";
import { Button, buttonVariants } from "@/components/ui/button";

/** "Try the demo" (opens the consent dialog) or, once it exists, "Open the demo". */
export function TryDemoButton({ variant = "outline" }: { variant?: "default" | "outline" | "ghost" }) {
  const { demoProjectId, openDemo } = useShell();
  if (demoProjectId) {
    return (
      <Link href={`/dashboard?project=${demoProjectId}`} className={buttonVariants({ variant })}>
        <FlaskConical aria-hidden /> Open the demo
      </Link>
    );
  }
  return (
    <Button variant={variant} onClick={openDemo}>
      <FlaskConical aria-hidden /> Try the demo
    </Button>
  );
}
