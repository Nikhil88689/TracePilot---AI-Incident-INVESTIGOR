"use server";

import { getCurrentUser } from "@/lib/auth/session";
import { getPublicEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { createApiKey, revokeApiKey, type ApiKeyRecord } from "./key-service";

export type CreateApiKeyState =
  | { status: "success"; key: string; record: ApiKeyRecord }
  | { status: "error"; message: string; fieldErrors?: { name?: string } };

export type RevokeApiKeyState = { status: "success"; revokedAt: string } | { status: "error"; message: string };

const SESSION_EXPIRED = "Your session has expired. Please sign in again.";

async function authedClient() {
  if (!getPublicEnv()) return null;
  const user = await getCurrentUser();
  if (!user?.email_confirmed_at) return null;
  return createClient();
}

export async function createApiKeyAction(input: { projectId: string; name: string }): Promise<CreateApiKeyState> {
  const supabase = await authedClient();
  if (!supabase) return { status: "error", message: SESSION_EXPIRED };
  const result = await createApiKey(supabase, input);
  return result.ok
    ? { status: "success", key: result.key, record: result.record }
    : { status: "error", message: result.message, fieldErrors: result.fieldErrors };
}

export async function revokeApiKeyAction(input: { keyId: string }): Promise<RevokeApiKeyState> {
  const supabase = await authedClient();
  if (!supabase) return { status: "error", message: SESSION_EXPIRED };
  const result = await revokeApiKey(supabase, input.keyId);
  return result.ok ? { status: "success", revokedAt: result.revokedAt } : { status: "error", message: result.message };
}
