import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

export const metadata: Metadata = { title: "Reset password" };

export default async function ForgotPasswordPage({ searchParams }: PageProps<"/forgot-password">) {
  const params = await searchParams;
  const notice =
    params.error === "expired"
      ? ({ status: "error", message: "That reset link is invalid or has expired. Request a new one." } as const)
      : undefined;

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">Reset your password</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Enter your email and we&apos;ll send you a link to choose a new password.
      </p>
      <ForgotPasswordForm notice={notice} />
    </>
  );
}
