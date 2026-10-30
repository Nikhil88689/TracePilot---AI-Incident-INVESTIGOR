import type { ReactNode } from "react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type Props = {
  title: string;
  description?: string;
  action?: ReactNode;
  /** When set, replaces the chart body (use an <EmptyState/>). */
  empty?: ReactNode;
  /** Fixed plot height keeps charts compact and prevents layout shift. */
  heightClass?: string;
  className?: string;
  children: ReactNode;
};

export function ChartCard({ title, description, action, empty, heightClass = "h-64", className, children }: Props) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      <CardContent>{empty ?? <div className={cn("w-full", heightClass)}>{children}</div>}</CardContent>
    </Card>
  );
}

export function ChartCardSkeleton({ className }: { className?: string }) {
  return (
    <Card className={className} aria-hidden>
      <CardHeader>
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3.5 w-52" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-64 w-full" />
      </CardContent>
    </Card>
  );
}
