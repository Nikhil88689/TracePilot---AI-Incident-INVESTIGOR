"use client";

import { useState, type ComponentProps, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, Eye, EyeOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AuthFormState } from "@/lib/auth/schemas";

type FieldProps = Omit<ComponentProps<typeof Input>, "id" | "name"> & {
  name: string;
  label: string;
  error?: string;
  /** Extra id(s) of helper text to associate, e.g. a requirements list. */
  describedBy?: string;
  /** Content placed on the label row, right-aligned (e.g. "Forgot password?"). */
  labelAction?: ReactNode;
};

export function Field({ name, label, error, describedBy, labelAction, ...props }: FieldProps) {
  const errorId = `${name}-error`;
  const described = [error ? errorId : null, describedBy].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={name}>{label}</Label>
        {labelAction}
      </div>
      <Input id={name} name={name} aria-invalid={Boolean(error)} aria-describedby={described} {...props} />
      {error ? (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function PasswordField(props: Omit<FieldProps, "type">) {
  const [visible, setVisible] = useState(false);
  const { name, label, error, describedBy, labelAction, className, ...rest } = props;
  const errorId = `${name}-error`;
  const described = [error ? errorId : null, describedBy].filter(Boolean).join(" ") || undefined;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={name}>{label}</Label>
        {labelAction}
      </div>
      <div className="relative">
        <Input
          id={name}
          name={name}
          type={visible ? "text" : "password"}
          aria-invalid={Boolean(error)}
          aria-describedby={described}
          className={`pr-10 ${className ?? ""}`}
          {...rest}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
        >
          {visible ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
        </Button>
      </div>
      {error ? (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Live region so screen readers announce both errors and success. */
export function FormMessage({ state }: { state: AuthFormState }) {
  return (
    <div aria-live="polite">
      {state.status === "error" && state.message ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden /> {state.message}
        </p>
      ) : null}
      {state.status === "success" && state.message ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success"
        >
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden /> {state.message}
        </p>
      ) : null}
    </div>
  );
}

export function SubmitButton({ pending, children, pendingLabel }: { pending: boolean; children: ReactNode; pendingLabel: string }) {
  return (
    <Button type="submit" className="w-full" size="lg" disabled={pending}>
      {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
      {pending ? pendingLabel : children}
    </Button>
  );
}
