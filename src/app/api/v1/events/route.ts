import { getPublicEnv } from "@/lib/env";
import { handleIngest } from "@/lib/ingest/handler";
import { createSupabaseIngestStore } from "@/lib/ingest/supabase-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unavailable = () =>
  Response.json(
    { error: { code: "ingestion_unavailable", message: "Event ingestion is not configured on this server." } },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );

/**
 * Event ingestion. Authenticated by a project API key (Authorization: Bearer tp_live_...),
 * never by a user session: cookies are ignored here and API keys are ignored everywhere else.
 */
export async function POST(request: Request) {
  if (!getPublicEnv() || !process.env.SUPABASE_SERVICE_ROLE_KEY) return unavailable();
  return handleIngest(request, { store: createSupabaseIngestStore() });
}
