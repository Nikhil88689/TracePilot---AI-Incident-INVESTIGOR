"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Could not access the clipboard. Select the text and copy it manually.");
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={copy}>
      <Copy aria-hidden /> {label}
    </Button>
  );
}
