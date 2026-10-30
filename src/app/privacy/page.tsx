import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/layout/logo";

export const metadata: Metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <Logo className="mb-8" />
      <h1 className="text-2xl font-semibold tracking-tight">Privacy notice</h1>
      <div className="mt-4 space-y-4 text-sm text-muted-foreground">
        <p>
          When you sign up, TracePilot stores your name, email address, and a hashed password in Supabase
          Authentication. Projects you create, and the events you send to them, are stored in a Supabase Postgres
          database and are visible only to your account.
        </p>
        <p>
          Authentication uses cookies to keep you signed in. TracePilot does not sell your data. This is a
          plain-language summary for a portfolio project, not legal advice, and makes no compliance claims.
        </p>
      </div>
      <Link href="/signup" className="mt-8 inline-block text-sm underline underline-offset-4">
        Back to sign up
      </Link>
    </main>
  );
}
