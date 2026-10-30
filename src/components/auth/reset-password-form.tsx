"use client";

import { useActionState } from "react";
import { updatePassword } from "@/lib/auth/actions";
import { PASSWORD_RULES } from "@/lib/auth/password";
import type { AuthFormState } from "@/lib/auth/schemas";
import { FormMessage, PasswordField, SubmitButton } from "./fields";

export function ResetPasswordForm() {
  const [state, formAction, pending] = useActionState<AuthFormState, FormData>(updatePassword, { status: "idle" });

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <PasswordField
        name="password"
        label="New password"
        autoComplete="new-password"
        required
        describedBy="reset-rules"
        error={state.fieldErrors?.password}
      />
      <ul id="reset-rules" aria-label="Password requirements" className="space-y-1 text-xs text-muted-foreground">
        {PASSWORD_RULES.map((rule) => (
          <li key={rule.id}>{rule.label}</li>
        ))}
      </ul>
      <PasswordField
        name="confirm"
        label="Confirm new password"
        autoComplete="new-password"
        required
        error={state.fieldErrors?.confirm}
      />
      <FormMessage state={state} />
      <SubmitButton pending={pending} pendingLabel="Updating…">
        Update password
      </SubmitButton>
    </form>
  );
}
