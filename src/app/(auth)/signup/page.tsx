import type { Metadata } from "next";
import { SignupForm } from "@/components/auth/signup-form";

export const metadata: Metadata = { title: "Create account" };

export default function SignupPage() {
  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">Create your account</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Start grouping errors into incidents. We&apos;ll email you a link to confirm your address.
      </p>
      <SignupForm />
    </>
  );
}
