"use server";

import { redirect } from "next/navigation";
import { getPublicEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "./redirect";
import {
  forgotPasswordSchema,
  parseForm,
  resetPasswordSchema,
  signInSchema,
  signUpSchema,
  type AuthFormState,
} from "./schemas";

const NOT_CONFIGURED: AuthFormState = {
  status: "error",
  message: "Supabase is not configured. Set the environment variables listed in .env.example.",
};

export async function signIn(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  if (!getPublicEnv()) return NOT_CONFIGURED;

  const parsed = parseForm(signInSchema, formData, ["email", "password"], ["email"]);
  if (!parsed.ok) return parsed.state;

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    const values = { email: parsed.data.email };
    if (error.code === "email_not_confirmed") {
      return {
        status: "error",
        values,
        message: "Please confirm your email first. Check your inbox for the verification link.",
      };
    }
    // One message for unknown email and wrong password, so accounts cannot be enumerated.
    return { status: "error", values, message: "Invalid email or password." };
  }

  redirect(safeNextPath(String(formData.get("next") ?? "")));
}

export async function signUp(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const env = getPublicEnv();
  if (!env) return NOT_CONFIGURED;

  const parsed = parseForm(signUpSchema, formData, ["fullName", "email", "password"], ["email", "fullName"]);
  if (!parsed.ok) return parsed.state;

  const { fullName, email, password } = parsed.data;
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName },
      emailRedirectTo: `${env.NEXT_PUBLIC_SITE_URL}/auth/callback`,
    },
  });
  if (error) {
    return { status: "error", message: error.message, values: { email, fullName } };
  }

  // Email confirmation enabled (required setting): no session until the link is clicked.
  if (!data.session) {
    return {
      status: "success",
      message: `We sent a confirmation link to ${email}. Open it to activate your account, then sign in.`,
    };
  }
  // Confirmation is disabled in the Supabase dashboard. We do not create the session, but we
  // cannot undo that setting here; the README documents that it must be enabled.
  redirect("/dashboard");
}

export async function requestPasswordReset(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const env = getPublicEnv();
  if (!env) return NOT_CONFIGURED;

  const parsed = parseForm(forgotPasswordSchema, formData, ["email"], ["email"]);
  if (!parsed.ok) return parsed.state;

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${env.NEXT_PUBLIC_SITE_URL}/auth/callback?next=/reset-password`,
  });
  // Rate limits are worth surfacing; anything else is hidden to avoid revealing which emails exist.
  if (error?.code === "over_email_send_rate_limit") {
    return { status: "error", message: "Too many requests. Wait a minute and try again.", values: parsed.data };
  }
  return {
    status: "success",
    message: "If an account exists for that email, a reset link is on its way.",
  };
}

export async function updatePassword(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  if (!getPublicEnv()) return NOT_CONFIGURED;

  const parsed = parseForm(resetPasswordSchema, formData, ["password", "confirm"]);
  if (!parsed.ok) return parsed.state;

  const supabase = await createClient();
  // Requires the recovery session established by /auth/callback.
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    const expired = error.status === 401 || error.code === "session_not_found";
    return {
      status: "error",
      message: expired
        ? "Your reset link has expired. Request a new one."
        : error.code === "same_password"
          ? "Choose a password different from your current one."
          : "Could not update your password. Please try again.",
    };
  }

  await supabase.auth.signOut();
  redirect("/login?message=password-updated");
}

export async function signOut(): Promise<void> {
  if (getPublicEnv()) {
    const supabase = await createClient();
    await supabase.auth.signOut();
  }
  redirect("/login");
}
