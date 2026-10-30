import type { IncidentStatus } from "@/lib/dashboard/types";

/**
 * Allowed incident status transitions. The database enforces the same table in a trigger
 * (incidents_status_guard); this copy exists so the UI only offers valid actions and the server
 * can reject bad requests before touching the database.
 */
export const TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  open: ["investigating", "resolved"],
  investigating: ["resolved"],
  resolved: ["open"],
};

export function canTransition(from: IncidentStatus, to: IncidentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export type StatusAction = { id: "acknowledge" | "resolve" | "reopen"; label: string; to: IncidentStatus };

export const STATUS_LABELS: Record<IncidentStatus, string> = {
  open: "Open",
  investigating: "Investigating",
  resolved: "Resolved",
};

export function actionsFor(status: IncidentStatus): StatusAction[] {
  switch (status) {
    case "open":
      return [
        { id: "acknowledge", label: "Acknowledge", to: "investigating" },
        { id: "resolve", label: "Resolve", to: "resolved" },
      ];
    case "investigating":
      return [{ id: "resolve", label: "Resolve", to: "resolved" }];
    case "resolved":
      return [{ id: "reopen", label: "Reopen", to: "open" }];
  }
}
