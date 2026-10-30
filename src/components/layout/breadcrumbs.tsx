"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { SEGMENT_LABELS } from "./nav-items";
import { useDashboardParams } from "./shell-context";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function Breadcrumbs() {
  const pathname = usePathname();
  const { project, hrefFor } = useDashboardParams();

  const segments = pathname.split("/").filter(Boolean);
  const crumbs = segments.map((segment, index) => ({
    href: "/" + segments.slice(0, index + 1).join("/"),
    // A full UUID is noise in a header (and overflows on phones), so show a short form.
    label: SEGMENT_LABELS[segment] ?? (UUID.test(segment) ? `Incident ${segment.slice(0, 8)}` : segment),
    // Dynamic ids (e.g. an incident id) are identifiers, so render them in mono.
    mono: !(segment in SEGMENT_LABELS),
  }));

  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        <BreadcrumbItem className="hidden sm:inline-flex">
          <span className="max-w-[10rem] truncate text-muted-foreground">{project?.name ?? "All projects"}</span>
        </BreadcrumbItem>
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <Fragment key={crumb.href}>
              <BreadcrumbSeparator className="hidden sm:block" />
              <BreadcrumbItem className={last ? "min-w-0" : "hidden sm:inline-flex"}>
                {last ? (
                  <BreadcrumbPage className={crumb.mono ? "truncate font-mono text-xs" : "truncate"}>
                    {crumb.label}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink render={<Link href={hrefFor(crumb.href)} />}>{crumb.label}</BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
