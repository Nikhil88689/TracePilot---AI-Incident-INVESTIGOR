"use client";

import Link from "next/link";
import { useActionState } from "react";
import { requestPasswordReset } from "@/lib/auth/actions";
import type { AuthFormState } from "@/lib/auth/schemas";
import { Field, FormMessage, SubmitButton } from "./fields";

export function ForgotPasswordForm({ notice }: { notice?: AuthFormState }) {
  const [state, formAction, pending] = useActionState<AuthFormState, FormData>(
    requestPasswordReset,
    notice ?? { status: "idle" },
  );

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <Field
        name="email"
        label="Email"
        type="email"
        autoComplete="email"
        required
        defaultValue={state.values?.email}
        error={state.fieldErrors?.email}
      />
      <FormMessage state={state} />
      <SubmitButton pending={pending} pendingLabel="Sending…">
        Send reset link
      </SubmitButton>
      <p className="text-center text-sm text-muted-foreground">
        <Link href="/login" className="text-foreground underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
