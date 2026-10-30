/**
 * `next dev` compiles each route the first time it is requested, and a cold compile can outlast a click that
 * races hydration. Request the public pages once before the specs start so the specs measure the app, not the compiler.
 * Harmless against a production server (just a few cached GETs).
 */
export default async function globalSetup() {
  const base = process.env.E2E_BASE_URL ?? "http://localhost:3100";
  for (const path of ["/", "/login", "/signup", "/forgot-password", "/reset-password", "/terms", "/privacy", "/dashboard", "/api/health"]) {
    await fetch(`${base}${path}`, { redirect: "manual" }).catch(() => undefined);
  }
}
