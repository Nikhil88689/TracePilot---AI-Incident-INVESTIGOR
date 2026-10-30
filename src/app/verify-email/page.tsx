import type { Metadata } from "next";
import { MailCheck } from "lucide-react";
import { Logo } from "@/components/layout/logo";
import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/auth/actions";

export const metadata: Metadata = { title: "Verify your email" };

/** Reached only if a session exists for an unverified address; private pages refuse it. */
export default function VerifyEmailPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 text-center">
      <Logo />
      <div className="max-w-sm space-y-3">
        <MailCheck className="mx-auto size-8 text-primary" aria-hidden />
        <h1 className="text-xl font-semibold">Verify your email</h1>
        <p className="text-sm text-muted-foreground">
          Open the confirmation link we emailed you to activate your account, then sign in again.
        </p>
      </div>
      <form action={signOut}>
        <Button variant="outline" type="submit">
          Sign out
        </Button>
      </form>
    </main>
  );
}
