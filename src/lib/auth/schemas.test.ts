import { describe, expect, it } from "vitest";
import { failedPasswordRules } from "./password";
import { forgotPasswordSchema, parseForm, resetPasswordSchema, signInSchema, signUpSchema } from "./schemas";

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

describe("password rules", () => {
  it("lists what is missing", () => {
    expect(failedPasswordRules("short").map((r) => r.id)).toEqual(["length", "number"]);
    expect(failedPasswordRules("12345678").map((r) => r.id)).toEqual(["letter"]);
    expect(failedPasswordRules("abcdefg1")).toEqual([]);
    expect(failedPasswordRules("a1".repeat(40)).map((r) => r.id)).toEqual(["max"]);
  });
});

describe("signInSchema", () => {
  it("only requires a non-empty password so older accounts are not locked out", () => {
    expect(signInSchema.safeParse({ email: "a@b.co", password: "x" }).success).toBe(true);
    expect(signInSchema.safeParse({ email: "a@b.co", password: "" }).success).toBe(false);
    expect(signInSchema.safeParse({ email: "nope", password: "x" }).success).toBe(false);
  });
});

describe("signUpSchema", () => {
  const ok = { fullName: " Ada Lovelace ", email: "ada@example.com", password: "analytical1" };
  it("accepts valid input and trims the name", () => {
    const r = signUpSchema.safeParse(ok);
    expect(r.success && r.data.fullName).toBe("Ada Lovelace");
  });
  it("rejects a weak password, blank name, and bad email", () => {
    expect(signUpSchema.safeParse({ ...ok, password: "password" }).success).toBe(false);
    expect(signUpSchema.safeParse({ ...ok, fullName: "  " }).success).toBe(false);
    expect(signUpSchema.safeParse({ ...ok, email: "ada" }).success).toBe(false);
  });
});

describe("resetPasswordSchema / forgotPasswordSchema", () => {
  it("requires matching confirmation", () => {
    const r = resetPasswordSchema.safeParse({ password: "abcdefg1", confirm: "abcdefg2" });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0].path).toEqual(["confirm"]);
  });
  it("validates the email", () => {
    expect(forgotPasswordSchema.safeParse({ email: "x" }).success).toBe(false);
  });
});

describe("parseForm", () => {
  it("returns per-field errors and echoes non-secret values only", () => {
    const result = parseForm(
      signUpSchema,
      form({ fullName: "Ada", email: "bad", password: "short" }),
      ["fullName", "email", "password"],
      ["email", "fullName"],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.state.fieldErrors?.email).toBeDefined();
      expect(result.state.fieldErrors?.password).toMatch(/at least 8/);
      expect(result.state.values).toEqual({ email: "bad", fullName: "Ada" });
      expect(JSON.stringify(result.state)).not.toContain("short\"");
    }
  });
  it("treats missing fields as invalid", () => {
    expect(parseForm(signInSchema, new FormData(), ["email", "password"]).ok).toBe(false);
  });
});
