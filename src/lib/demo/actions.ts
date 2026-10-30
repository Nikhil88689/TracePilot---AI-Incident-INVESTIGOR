"use server";

import { getCurrentUser } from "@/lib/auth/session";
import { getPublicEnv } from "@/lib/env";
import { asRpc } from "@/lib/incidents/queries";
import { createClient } from "@/lib/supabase/server";
import { removeDemo, seedDemo } from "./service";

const EXPIRED = "Your session has expired. Please sign in again.";

async function authedDb() {
  if (!getPublicEnv()) return null;
  const user = await getCurrentUser();
  if (!user?.email_confirmed_at) return null;
  return asRpc(await createClient());
}

export type StartDemoState = { status: "ok"; projectId: string; created: boolean } | { status: "error"; message: string };

/** Explicit, user-initiated: the UI asks for consent first. Separate from event ingestion. */
export async function startDemoAction(input: { reset?: boolean }): Promise<StartDemoState> {
  const db = await authedDb();
  if (!db) return { status: "error", message: EXPIRED };
  try {
    const result = await seedDemo(db, { reset: input?.reset === true });
    if (result.ok) return { status: "ok", projectId: result.projectId, created: result.created };
    return {
      status: "error",
      message:
        result.reason === "name_taken"
          ? 'You already have a project named "Demo (simulated storefront)". Rename it, then try again.'
          : EXPIRED,
    };
  } catch {
    return { status: "error", message: "Could not set up the demo. Please try again." };
  }
}

export type RemoveDemoState = { status: "ok"; removed: boolean } | { status: "error"; message: string };

export async function removeDemoAction(): Promise<RemoveDemoState> {
  const db = await authedDb();
  if (!db) return { status: "error", message: EXPIRED };
  try {
    return { status: "ok", removed: await removeDemo(db) };
  } catch {
    return { status: "error", message: "Could not remove the demo. Please try again." };
  }
}
