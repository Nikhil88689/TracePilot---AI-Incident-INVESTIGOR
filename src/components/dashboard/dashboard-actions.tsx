"use client";

import Link from "next/link";
import { Send } from "lucide-react";
import { TryDemoButton } from "@/components/demo/try-demo-button";
import { Button, buttonVariants } from "@/components/ui/button";
import { useDashboardParams, useShell } from "@/components/layout/shell-context";

export function DashboardActions() {
  const { openTestEvent } = useShell();
  const { hrefFor, project } = useDashboardParams();

  return (
    <>
      <Button onClick={openTestEvent}>
        <Send aria-hidden /> Send test event
      </Button>
      <Link href={hrefFor("/incidents")} className={buttonVariants({ variant: "outline" })}>
        View incidents
      </Link>
      {project?.isDemo ? null : <TryDemoButton variant="ghost" />}
    </>
  );
}
