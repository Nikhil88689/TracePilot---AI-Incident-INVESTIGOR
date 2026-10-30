import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { safeNextPath } from "@/lib/auth/redirect";
import { getPublicEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

const otpTypeSchema = z.enum(["signup", "invite", "magiclink", "recovery", "email_change", "email"]);

/**
 * Landing point for every Supabase email link (confirm signup, reset password).
 * Supports the PKCE `?code=` flow (default templates) and the `?token_hash=&type=` flow
 * (custom templates, which also work when the link is opened on another device).
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = otpTypeSchema.safeParse(searchParams.get("type"));
  const next = safeNextPath(searchParams.get("next"));
  const isRecovery = next === "/reset-password" || (type.success && type.data === "recovery");

  if (getPublicEnv() && (code || (tokenHash && type.success))) {
    const supabase = await createClient();
    const { error } =
      code
        ? await supabase.auth.exchangeCodeForSession(code)
        : await supabase.auth.verifyOtp({ token_hash: tokenHash!, type: type.data as EmailOtpType });
    if (!error) return NextResponse.redirect(`${origin}${isRecovery ? "/reset-password" : next}`);
  }

  // Invalid, expired, or already-used link.
  return NextResponse.redirect(
    `${origin}${isRecovery ? "/forgot-password?error=expired" : "/login?error=callback"}`,
  );
}
