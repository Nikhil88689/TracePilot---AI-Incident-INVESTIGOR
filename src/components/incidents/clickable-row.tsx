"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { TableRow } from "@/components/ui/table";

/**
 * Makes a whole table row navigate on click. The row's own link remains the keyboard and
 * screen-reader path, so this is a pointer convenience, not the only way in.
 */
export function ClickableRow({ href, children }: { href: string; children: ReactNode }) {
  const router = useRouter();
  return (
    <TableRow
      className="cursor-pointer"
      onClick={(event) => {
        // Let real links/buttons inside the row do their own thing (including ctrl/cmd-click).
        if ((event.target as HTMLElement).closest("a, button")) return;
        router.push(href);
      }}
    >
      {children}
    </TableRow>
  );
}
