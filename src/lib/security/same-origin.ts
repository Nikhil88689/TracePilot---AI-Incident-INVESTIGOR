/**
 * CSRF guard for cookie-authenticated JSON endpoints. Browsers always send Origin on cross-site POSTs and
 * Sec-Fetch-Site on modern ones, so either signal proves the request did not come from this site.
 * Requests with neither header (curl, server-to-server) are allowed through: they cannot ride a victim's
 * cookies. Pair with a JSON content-type check, which a plain HTML form cannot produce.
 */
export function isCrossSiteRequest(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return true;
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true; // an unparseable Origin (including "null") is never ours
  }
}

export const isJsonRequest = (request: Request) => (request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");
