import { getAiConfig } from "@/lib/ai/config";
import { handleAnalyze } from "@/lib/ai/analyze-handler";
import { getCurrentUser } from "@/lib/auth/session";
import { getPublicEnv } from "@/lib/env";
import { asRpc } from "@/lib/incidents/queries";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The provider call is bounded by AI_TIMEOUT_MS (max 55 s); allow the function that long.
export const maxDuration = 60;

export async function POST(request: Request, { params }: { params: Promise<{ incidentId: string }> }) {
  if (!getPublicEnv()) {
    return Response.json({ error: { code: "not_configured", message: "Supabase is not configured.", retryable: false } }, { status: 503 });
  }
  const { incidentId } = await params;
  return handleAnalyze(request, incidentId, {
    getUser: getCurrentUser,
    getDb: async () => asRpc(await createClient()),
    getConfig: () => getAiConfig(),
  });
}
