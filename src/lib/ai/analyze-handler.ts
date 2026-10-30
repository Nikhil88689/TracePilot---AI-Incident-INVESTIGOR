import { isCrossSiteRequest, isJsonRequest } from "@/lib/security/same-origin";
import { parseUuid } from "@/lib/incidents/params";
import type { RpcClient } from "@/lib/incidents/queries";
import type { AiConfig } from "./config";
import { investigateIncident, type AiClient, type InvestigateResult } from "./investigate";

export type AnalyzeDeps = {
  getUser: () => Promise<{ id: string; email_confirmed_at?: string | null } | null>;
  getDb: () => Promise<RpcClient>;
  getConfig: () => AiConfig | null;
  /** Provider override for tests. */
  client?: AiClient;
};

const HEADERS = { "Cache-Control": "no-store" } as const;
const MAX_BODY_BYTES = 2_000;

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { ...HEADERS, ...headers } });
}

const fail = (status: number, code: string, message: string, retryable = false, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  json(status, { error: { code, message, retryable }, ...extra }, headers);

/** Failure code -> HTTP status. Retryable provider problems are 5xx/429 so clients can back off. */
const FAILURE_STATUS: Record<string, number> = {
  timeout: 504,
  rate_limited: 429,
  provider_unavailable: 502,
  provider_error: 502,
  invalid_response: 502,
  invalid_evidence: 502,
  refused: 422,
  no_events: 422,
  auth: 503,
  model_unavailable: 503,
  provider_rejected: 503,
  save_failed: 500,
};

/**
 * POST /api/v1/incidents/[incidentId]/analyze
 *
 * Authenticated by the user's session (never by an ingestion API key; Authorization headers are
 * ignored). Because it is cookie-authenticated and spends money, it also rejects cross-site
 * requests and anything that is not a JSON request, which a plain HTML form cannot produce.
 * The request body is never used to build the prompt: only stored evidence is.
 */
export async function handleAnalyze(request: Request, incidentId: string, deps: AnalyzeDeps): Promise<Response> {
  if (isCrossSiteRequest(request)) return fail(403, "forbidden", "Cross-site requests are not allowed.");
  if (!isJsonRequest(request)) return fail(415, "unsupported_media_type", "Content-Type must be application/json.");

  const user = await deps.getUser();
  if (!user || !user.email_confirmed_at) return fail(401, "unauthorized", "Sign in to run an investigation.");

  const id = parseUuid(incidentId);
  if (!id) return fail(404, "not_found", "Incident not found.");

  // The body is not used for anything; refuse a large one rather than buffering it.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return fail(413, "payload_too_large", "Request body is too large.");
  }
  const body = (await request.text().catch(() => "")).slice(0, MAX_BODY_BYTES);
  if (body.trim()) {
    try {
      JSON.parse(body);
    } catch {
      return fail(400, "invalid_json", "Body must be valid JSON.");
    }
  }

  const config = deps.getConfig();
  if (!config) {
    return fail(503, "ai_not_configured", "AI analysis is not configured on this server. Set ANTHROPIC_API_KEY to enable it.");
  }

  let result: InvestigateResult;
  try {
    result = await investigateIncident(await deps.getDb(), id, { config, client: deps.client });
  } catch {
    return fail(500, "internal_error", "Could not run the analysis. Try again.", true);
  }

  switch (result.status) {
    case "complete":
      return json(200, { analysis: result.analysis });
    case "not_found":
      // Same answer for "does not exist" and "belongs to someone else".
      return fail(404, "not_found", "Incident not found.");
    case "not_configured":
      return fail(503, "ai_not_configured", "AI analysis is not configured on this server.");
    case "in_progress":
      return fail(409, "analysis_in_progress", "An analysis is already running for this incident.", true, {}, { "Retry-After": "10" });
    case "rate_limited":
      return fail(429, "analysis_rate_limited", "Too many analyses started recently. Try again later.", true, {}, { "Retry-After": "300" });
    case "failed":
      return fail(
        FAILURE_STATUS[result.code] ?? 500,
        result.code,
        result.message,
        result.retryable,
        { analysis: result.analysis },
        result.retryable && result.code === "rate_limited" ? { "Retry-After": "30" } : {},
      );
  }
}
