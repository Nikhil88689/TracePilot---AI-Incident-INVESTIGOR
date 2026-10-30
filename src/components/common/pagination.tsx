import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  /** Builds the URL for a page; computed on the server so this stays a plain link. */
  hrefFor: (page: number) => string;
  noun?: string;
};

const disabled = "pointer-events-none opacity-50";

/** Link-based pagination: works without JavaScript, is bookmarkable, and survives refresh. */
export function Pagination({ page, pageCount, total, pageSize, hrefFor, noun = "results" }: Props) {
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-xs text-muted-foreground">
      <p>
        Showing <span className="tabular-nums text-foreground">{from}–{to}</span> of{" "}
        <span className="tabular-nums text-foreground">{total}</span> {noun}
      </p>
      <div className="flex items-center gap-1">
        <Link
          href={hrefFor(page - 1)}
          scroll={false}
          aria-label="Previous page"
          aria-disabled={page <= 1}
          tabIndex={page <= 1 ? -1 : undefined}
          className={cn(buttonVariants({ variant: "outline", size: "icon-sm" }), page <= 1 && disabled)}
        >
          <ChevronLeft aria-hidden />
        </Link>
        <span className="px-2 tabular-nums">
          Page {page} of {pageCount}
        </span>
        <Link
          href={hrefFor(page + 1)}
          scroll={false}
          aria-label="Next page"
          aria-disabled={page >= pageCount}
          tabIndex={page >= pageCount ? -1 : undefined}
          className={cn(buttonVariants({ variant: "outline", size: "icon-sm" }), page >= pageCount && disabled)}
        >
          <ChevronRight aria-hidden />
        </Link>
      </div>
    </nav>
  );
}
