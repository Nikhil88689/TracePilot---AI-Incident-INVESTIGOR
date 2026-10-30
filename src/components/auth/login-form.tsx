"use client";

import Link from "next/link";
import { useActionState } from "react";
import { signIn } from "@/lib/auth/actions";
import type { AuthFormState } from "@/lib/auth/schemas";
import { Field, FormMessage, PasswordField, SubmitButton } from "./fields";

type Props = { next?: string; notice?: AuthFormState };

export function LoginForm({ next, notice }: Props) {
  const [state, formAction, pending] = useActionState<AuthFormState, FormData>(signIn, notice ?? { status: "idle" });

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {next ? <input type="hidden" name="next" value={next} /> : null}

      <Field
        name="email"
        label="Email"
        type="email"
        autoComplete="email"
        required
        defaultValue={state.values?.email}
        error={state.fieldErrors?.email}
      />
      <PasswordField
        name="password"
        label="Password"
        autoComplete="current-password"
        required
        error={state.fieldErrors?.password}
        labelAction={
          <Link href="/forgot-password" className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            Forgot password?
          </Link>
        }
      />

      <FormMessage state={state} />
      <SubmitButton pending={pending} pendingLabel="Signing in…">
        Sign in
      </SubmitButton>

      <p className="text-center text-sm text-muted-foreground">
        New to TracePilot?{" "}
        <Link href="/signup" className="text-foreground underline-offset-4 hover:underline">
          Create an account
        </Link>
      </p>
    </form>
  );
}
