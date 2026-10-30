import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requirePublicEnv, requireServiceRoleKey } from "@/lib/env";

let client: SupabaseClient | undefined;

/**
 * Service-role client: BYPASSES Row Level Security. Server-only (the import above fails the
 * build if a client component pulls this in). Use it exclusively where there is no user
 * session to act as, i.e. API-key authenticated ingestion, and always scope queries yourself.
 */
export function createAdminClient(): SupabaseClient {
  client ??= createClient(requirePublicEnv().NEXT_PUBLIC_SUPABASE_URL, requireServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
