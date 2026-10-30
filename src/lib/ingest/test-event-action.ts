"use server";

import { getCurrentUser } from "@/lib/auth/session";
import { getPublicEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { sendTestEvent, type TestEventResult } from "./test-event";

/** Protected: requires a verified, signed-in user who owns the project. */
export async function sendTestEventAction(input: { projectId: string }): Promise<TestEventResult> {
  const env = getPublicEnv();
  if (!env) return { ok: false, message: "Supabase is not configured." };

  const user = await getCurrentUser();
  if (!user?.email_confirmed_at) return { ok: false, message: "Your session has expired. Please sign in again." };

  return sendTestEvent(input?.projectId, { supabase: await createClient(), siteUrl: env.NEXT_PUBLIC_SITE_URL });
}
