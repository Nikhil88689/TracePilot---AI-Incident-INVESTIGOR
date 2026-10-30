import { z } from "zod";
import { failedPasswordRules } from "./password";

const email = z.email("Enter a valid email address.").max(254, "Email is too long.");

export const newPasswordSchema = z
  .string()
  .superRefine((value, ctx) => {
    const failed = failedPasswordRules(value);
    if (failed.length > 0) {
      ctx.addIssue({ code: "custom", message: `Password needs: ${failed.map((r) => r.label.toLowerCase()).join("; ")}.` });
    }
  });

/** Sign-in only checks presence: existing accounts must not be locked out by a newer policy. */
export const signInSchema = z.object({
  email,
  password: z.string().min(1, "Enter your password.").max(256),
});

export const signUpSchema = z.object({
  fullName: z.string().trim().min(1, "Enter your name.").max(100, "Name is too long."),
  email,
  password: newPasswordSchema,
});

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z
  .object({ password: newPasswordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Passwords do not match." });

export type AuthFormState = {
  status: "idle" | "error" | "success";
  message?: string;
  fieldErrors?: Partial<Record<string, string>>;
  /** Echoed back so a failed submit does not wipe what the user typed (never the password). */
  values?: Partial<Record<"email" | "fullName", string>>;
};

type ParseResult<T> = { ok: true; data: T } | { ok: false; state: AuthFormState };

/** Validates form data against a schema and maps Zod issues to per-field messages. */
export function parseForm<S extends z.ZodType>(
  schema: S,
  formData: FormData,
  fields: string[],
  echo: ("email" | "fullName")[] = [],
): ParseResult<z.infer<S>> {
  const raw: Record<string, FormDataEntryValue | null> = {};
  for (const field of fields) raw[field] = formData.get(field);

  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };

  const fieldErrors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? "form");
    fieldErrors[key] ??= issue.message;
  }
  const values: AuthFormState["values"] = {};
  for (const key of echo) {
    const value = formData.get(key);
    if (typeof value === "string") values[key] = value;
  }
  return {
    ok: false,
    state: { status: "error", message: "Please fix the highlighted fields.", fieldErrors, values },
  };
}
