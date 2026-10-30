import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { getCurrentUser } from "@/lib/auth/session";
import { isSupabaseConfigured } from "@/lib/env";

export const metadata: Metadata = { title: "Choose a new password" };
export const dynamic = "force-dynamic";

export default async function ResetPasswordPage() {
  // The recovery link signs the user in via /auth/callback; without that session there is nothing to reset.
  if (isSupabaseConfigured() && !(await getCurrentUser())) redirect("/forgot-password?error=expired");

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">Choose a new password</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">You&apos;ll be asked to sign in again afterwards.</p>
      <ResetPasswordForm />
    </>
  );
}
