"use server";

import { getCurrentUser } from "@/lib/auth/session";
import { getPublicEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import type { IncidentStatus } from "@/lib/dashboard/types";
import { asRpc, changeIncidentStatus, fetchEventDetail, setAnalysisStep } from "./queries";
import type { EventDetail } from "./types";

const EXPIRED = "Your session has expired. Please sign in again.";

/** Every action re-authenticates: a server action is a public endpoint, whatever page rendered it. */
async function authedDb() {
  if (!getPublicEnv()) return null;
  const user = await getCurrentUser();
  if (!user?.email_confirmed_at) return null;
  return asRpc(await createClient());
}

export type ChangeStatusState =
  | { status: "ok"; newStatus: IncidentStatus; resolvedAt: string | null }
  | { status: "conflict"; current: IncidentStatus }
  | { status: "error"; message: string };

export async function changeStatusAction(input: { incidentId: string; to: string; expected: string }): Promise<ChangeStatusState> {
  const db = await authedDb();
  if (!db) return { status: "error", message: EXPIRED };
  try {
    const result = await changeIncidentStatus(db, input);
    switch (result.result) {
      case "ok":
        return { status: "ok", newStatus: result.status, resolvedAt: result.resolvedAt };
      case "conflict":
        return { status: "conflict", current: result.status };
      case "not_found":
        return { status: "error", message: "This incident no longer exists or you don't have access to it." };
      case "invalid_transition":
        return { status: "error", message: "That status change isn't allowed from the current state." };
      case "invalid_input":
        return { status: "error", message: "Invalid request." };
    }
  } catch {
    return { status: "error", message: "Could not update the incident. Please try again." };
  }
}

export type EventDetailState = { status: "ok"; event: EventDetail } | { status: "error"; message: string };

export async function loadEventDetailAction(input: { eventId: string }): Promise<EventDetailState> {
  const db = await authedDb();
  if (!db) return { status: "error", message: EXPIRED };
  try {
    const event = await fetchEventDetail(db, input.eventId);
    return event ? { status: "ok", event } : { status: "error", message: "Event not found." };
  } catch {
    return { status: "error", message: "Could not load the event. Please try again." };
  }
}

export type StepState = { status: "ok"; completedSteps: number[] } | { status: "error"; message: string };

/** Ticks a recommended diagnostic step on or off (persisted). */
export async function toggleStepAction(input: { analysisId: string; index: number; done: boolean }): Promise<StepState> {
  const db = await authedDb();
  if (!db) return { status: "error", message: EXPIRED };
  try {
    const result = await setAnalysisStep(db, input);
    if (result.result === "ok") return { status: "ok", completedSteps: result.completedSteps };
    return { status: "error", message: result.result === "not_found" ? "This analysis no longer exists." : "Invalid request." };
  } catch {
    return { status: "error", message: "Could not save that change. Please try again." };
  }
}
