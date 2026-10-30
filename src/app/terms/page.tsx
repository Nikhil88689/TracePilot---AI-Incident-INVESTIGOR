import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/layout/logo";

export const metadata: Metadata = { title: "Terms" };

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <Logo className="mb-8" />
      <h1 className="text-2xl font-semibold tracking-tight">Terms of use</h1>
      <div className="mt-4 space-y-4 text-sm text-muted-foreground">
        <p>
          TracePilot is a portfolio and demonstration project. It is provided as is, without warranties, and is not
          intended for production workloads or for storing sensitive or regulated data.
        </p>
        <p>
          Don&apos;t send secrets, credentials, or personal data in error events. You are responsible for what your
          applications send to your project.
        </p>
        <p>
          Accounts may be removed at any time. This page is a plain-language summary and not legal advice; no
          compliance certification is claimed.
        </p>
      </div>
      <Link href="/signup" className="mt-8 inline-block text-sm underline underline-offset-4">
        Back to sign up
      </Link>
    </main>
  );
}
