import { z } from "zod";

/**
 * Public values are inlined by Next at build time, so each NEXT_PUBLIC_* variable
 * must be referenced literally. They are safe to expose to the browser.
 */
const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_SITE_URL: z.url().default("http://localhost:3000"),
});

/** Secrets. Only ever read from server-side code (route handlers, server actions). */
const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(55_000).default(30_000),
});

export type PublicEnv = z.infer<typeof publicSchema>;
export type ServerEnv = z.infer<typeof serverSchema>;

type Source = Record<string, string | undefined>;

/**
 * The public origin of this deployment, used in auth email links and the ingestion URL.
 *  1. NEXT_PUBLIC_SITE_URL when set (set it for Production only, so previews do not email production links)
 *  2. on Vercel Production: the project's production domain
 *  3. on Vercel Preview: this deployment's own URL
 *  4. undefined (the schema then falls back to http://localhost:3000 for local development)
 */
export function resolveSiteUrl(source: Source): string | undefined {
  const explicit = source.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit;
  const host = source.VERCEL_ENV === "production" ? source.VERCEL_PROJECT_PRODUCTION_URL || source.VERCEL_URL : source.VERCEL_URL;
  return host ? `https://${host.replace(/^https?:\/\//, "")}` : undefined;
}

/** Pure, for tests. The Supabase key accepts the current name (PUBLISHABLE_KEY) or the legacy ANON_KEY. */
export function resolvePublicEnv(source: Source) {
  return {
    NEXT_PUBLIC_SUPABASE_URL: source.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: source.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || source.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SITE_URL: resolveSiteUrl(source),
  };
}

function rawPublicEnv() {
  // NEXT_PUBLIC_* must be referenced literally so Next can inline them into client bundles.
  return resolvePublicEnv({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_URL: process.env.VERCEL_URL,
    VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  });
}

/** Returns the validated public config, or null when Supabase is not configured yet. */
export function getPublicEnv(): PublicEnv | null {
  const parsed = publicSchema.safeParse(rawPublicEnv());
  return parsed.success ? parsed.data : null;
}

export function isSupabaseConfigured(): boolean {
  return getPublicEnv() !== null;
}

/** Throws a descriptive error when public config is missing. */
export function requirePublicEnv(): PublicEnv {
  const parsed = publicSchema.safeParse(rawPublicEnv());
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Missing or invalid environment variables: ${fields}. See .env.example.`);
  }
  return parsed.data;
}

/** The service-role key, validated on its own so features that only need Supabase do not require AI keys. */
export function requireServiceRoleKey(source: Record<string, string | undefined> = process.env): string {
  const parsed = z.string().min(1).safeParse(source.SUPABASE_SERVICE_ROLE_KEY);
  if (!parsed.success) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY.");
  return parsed.data;
}

/** Lazily validated so the app boots (and builds) before AI/admin keys exist. */
export function getServerEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  const parsed = serverSchema.safeParse(source);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Missing or invalid server environment variables: ${fields}.`);
  }
  return parsed.data;
}
