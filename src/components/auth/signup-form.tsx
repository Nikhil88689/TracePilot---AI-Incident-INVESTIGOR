"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { Check, Circle } from "lucide-react";
import { signUp } from "@/lib/auth/actions";
import { PASSWORD_RULES } from "@/lib/auth/password";
import type { AuthFormState } from "@/lib/auth/schemas";
import { cn } from "@/lib/utils";
import { Field, FormMessage, PasswordField, SubmitButton } from "./fields";

export function SignupForm() {
  const [state, formAction, pending] = useActionState<AuthFormState, FormData>(signUp, { status: "idle" });
  const [password, setPassword] = useState("");

  if (state.status === "success") {
    return (
      <div className="space-y-4">
        <FormMessage state={state} />
        <p className="text-sm text-muted-foreground">
          Didn&apos;t get it? Check your spam folder. The link works once and expires after a while.
        </p>
        <Link href="/login" className="block text-center text-sm text-foreground underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <Field
        name="fullName"
        label="Full name"
        autoComplete="name"
        required
        defaultValue={state.values?.fullName}
        error={state.fieldErrors?.fullName}
      />
      <Field
        name="email"
        label="Email"
        type="email"
        autoComplete="email"
        required
        defaultValue={state.values?.email}
        error={state.fieldErrors?.email}
      />
      <div className="space-y-2">
        <PasswordField
          name="password"
          label="Password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          describedBy="password-rules"
          error={state.fieldErrors?.password}
        />
        <ul id="password-rules" aria-label="Password requirements" className="space-y-1 text-xs">
          {PASSWORD_RULES.map((rule) => {
            const met = rule.test(password);
            return (
              <li key={rule.id} className={cn("flex items-center gap-1.5", met ? "text-success" : "text-muted-foreground")}>
                {met ? <Check className="size-3.5" aria-hidden /> : <Circle className="size-3.5" aria-hidden />}
                {rule.label}
                <span className="sr-only">{met ? " (met)" : " (not met)"}</span>
              </li>
            );
          })}
        </ul>
      </div>

      <FormMessage state={state} />
      <SubmitButton pending={pending} pendingLabel="Creating account…">
        Create account
      </SubmitButton>

      <p className="text-center text-xs text-muted-foreground">
        By creating an account you agree to the{" "}
        <Link href="/terms" className="underline underline-offset-4 hover:text-foreground">
          Terms
        </Link>{" "}
        and acknowledge the{" "}
        <Link href="/privacy" className="underline underline-offset-4 hover:text-foreground">
          Privacy notice
        </Link>
        .
      </p>
      <p className="text-center text-sm text-muted-foreground">
        Already registered?{" "}
        <Link href="/login" className="text-foreground underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
