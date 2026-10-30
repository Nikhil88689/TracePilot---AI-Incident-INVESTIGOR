import "server-only";
import type { User } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/** Verified user (validated against Supabase Auth, not just the cookie) or null. */
export async function getCurrentUser(): Promise<User | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  return error ? null : data.user;
}

/**
 * Server-side gate for private pages and layouts. Never relies on client state.
 * An unverified email is refused even if a session somehow exists.
 */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!user.email_confirmed_at) redirect("/verify-email");
  return user;
}
