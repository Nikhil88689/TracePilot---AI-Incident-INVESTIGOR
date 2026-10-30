import { Activity, LayoutDashboard, Settings, Siren, Sparkles, type LucideIcon } from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shows the unresolved-incident count for the current project. */
  badge?: "unresolved";
};

export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/incidents", label: "Incidents", icon: Siren, badge: "unresolved" },
  { href: "/events", label: "Events", icon: Activity },
  { href: "/investigations", label: "AI Investigations", icon: Sparkles },
  { href: "/settings", label: "Project Settings", icon: Settings },
];

/** Human labels for breadcrumb segments. */
export const SEGMENT_LABELS: Record<string, string> = {
  dashboard: "Overview",
  incidents: "Incidents",
  events: "Events",
  investigations: "AI Investigations",
  settings: "Project Settings",
};
