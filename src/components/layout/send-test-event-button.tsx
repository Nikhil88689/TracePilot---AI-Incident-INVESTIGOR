"use client";

import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useShell } from "./shell-context";

/** Opens the shell's "Send test event" dialog from anywhere (used by empty states). */
export function SendTestEventButton({ variant = "default" }: { variant?: "default" | "outline" }) {
  const { openTestEvent } = useShell();
  return (
    <Button variant={variant} onClick={openTestEvent}>
      <Send aria-hidden /> Send test event
    </Button>
  );
}
