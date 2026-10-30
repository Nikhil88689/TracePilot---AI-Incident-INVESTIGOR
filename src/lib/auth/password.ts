/**
 * One source of truth for password requirements: the Zod schema enforces them and the
 * signup form renders the same list as a live checklist. (Supabase also enforces its own
 * minimum length from the dashboard; keep that at or below the value here.)
 */
export type PasswordRule = { id: string; label: string; test: (value: string) => boolean };

export const PASSWORD_MAX_LENGTH = 72; // bcrypt truncates beyond 72 bytes

export const PASSWORD_RULES: PasswordRule[] = [
  { id: "length", label: "At least 8 characters", test: (v) => v.length >= 8 },
  { id: "letter", label: "At least one letter", test: (v) => /[A-Za-z]/.test(v) },
  { id: "number", label: "At least one number", test: (v) => /\d/.test(v) },
  { id: "max", label: `No more than ${PASSWORD_MAX_LENGTH} characters`, test: (v) => v.length <= PASSWORD_MAX_LENGTH },
];

export function failedPasswordRules(value: string): PasswordRule[] {
  return PASSWORD_RULES.filter((rule) => !rule.test(value));
}
