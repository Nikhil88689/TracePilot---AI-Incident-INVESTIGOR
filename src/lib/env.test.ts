import { describe, expect, it } from "vitest";
import { getServerEnv, resolvePublicEnv, resolveSiteUrl } from "./env";

describe("getServerEnv", () => {
  it("applies defaults and coerces the timeout", () => {
    const env = getServerEnv({
      SUPABASE_SERVICE_ROLE_KEY: "svc",
      ANTHROPIC_API_KEY: "key",
      AI_TIMEOUT_MS: "20000",
    });
    expect(env.AI_TIMEOUT_MS).toBe(20000);
    expect(env.ANTHROPIC_MODEL).toBe("claude-sonnet-5-5");
  });

  it("throws naming the missing variables", () => {
    expect(() => getServerEnv({})).toThrow(/SUPABASE_SERVICE_ROLE_KEY.*ANTHROPIC_API_KEY/);
  });

  it("rejects timeouts that exceed the serverless budget", () => {
    expect(() =>
      getServerEnv({
        SUPABASE_SERVICE_ROLE_KEY: "svc",
        ANTHROPIC_API_KEY: "key",
        AI_TIMEOUT_MS: "999999",
      }),
    ).toThrow(/AI_TIMEOUT_MS/);
  });
});

describe("resolvePublicEnv", () => {
  const base = { NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co" };

  it("prefers the publishable key name and falls back to the legacy anon name", () => {
    expect(resolvePublicEnv({ ...base, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "pub", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" }).NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("pub");
    expect(resolvePublicEnv({ ...base, NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" }).NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("anon");
    expect(resolvePublicEnv({ ...base, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "" , NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" }).NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("anon");
  });
});

describe("resolveSiteUrl", () => {
  it("uses the explicit value first", () => {
    expect(resolveSiteUrl({ NEXT_PUBLIC_SITE_URL: " https://app.example.com ", VERCEL_ENV: "preview", VERCEL_URL: "x.vercel.app" })).toBe("https://app.example.com");
  });
  it("uses the production domain on Vercel Production", () => {
    expect(resolveSiteUrl({ VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "tracepilot.vercel.app", VERCEL_URL: "tp-abc.vercel.app" })).toBe("https://tracepilot.vercel.app");
  });
  it("uses the deployment's own URL on Preview, so email links stay on the preview", () => {
    expect(resolveSiteUrl({ VERCEL_ENV: "preview", VERCEL_PROJECT_PRODUCTION_URL: "tracepilot.vercel.app", VERCEL_URL: "tp-git-feat-me.vercel.app" })).toBe("https://tp-git-feat-me.vercel.app");
  });
  it("is undefined locally, so the schema default applies", () => {
    expect(resolveSiteUrl({})).toBeUndefined();
  });
});
