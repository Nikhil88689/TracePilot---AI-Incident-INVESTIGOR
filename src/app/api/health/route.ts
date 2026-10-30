import { NextResponse } from "next/server";
import { getAiConfig } from "@/lib/ai/config";
import { isSupabaseConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Liveness + configuration probe for uptime monitors and post-deploy checks.
 * It reports only whether each feature is configured (booleans). It never returns a value, a URL, a
 * version, a region or an error message, and it does not query the database, so it is cheap, cannot be
 * used to probe infrastructure, and stays up when Supabase is down.
 */
export function GET() {
  const supabaseConfigured = isSupabaseConfigured();
  return NextResponse.json(
    {
      status: "ok",
      service: "tracepilot",
      supabaseConfigured,
      ingestionConfigured: supabaseConfigured && Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
      aiConfigured: getAiConfig() !== null,
      time: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
