import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/login-form";
import { safeNextPath } from "@/lib/auth/redirect";
import type { AuthFormState } from "@/lib/auth/schemas";

export const metadata: Metadata = { title: "Sign in" };

function noticeFor(error: unknown, message: unknown): AuthFormState | undefined {
  if (message === "password-updated") {
    return { status: "success", message: "Password updated. Sign in with your new password." };
  }
  if (error === "callback") {
    return { status: "error", message: "That link is invalid or has expired. Sign in, or request a new one." };
  }
  return undefined;
}

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const next = typeof params.next === "string" ? safeNextPath(params.next) : undefined;

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">Welcome back</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">Sign in to continue investigating incidents.</p>
      <LoginForm next={next} notice={noticeFor(params.error, params.message)} />
    </>
  );
}
