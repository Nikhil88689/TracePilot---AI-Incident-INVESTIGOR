import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ingestUrl } from "@/lib/ingest-snippets";
import { generateApiKey } from "./keys";

export type TestEventResult =
  | { ok: true; created: boolean; incidentId: string; occurrenceCount: number }
  | { ok: false; message: string };

type Deps = {
  supabase: SupabaseClient;
  siteUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/** Stable stack and message so repeated test events group into one incident (and count up). */
export function buildTestEvent(project: { environment: string }, now = new Date()) {
  return {
    external_event_id: `dashboard-test-${crypto.randomUUID()}`,
    event_type: "TypeError",
    level: "error",
    message: "TracePilot test event: checkout total was NaN",
    occurred_at: now.toISOString(),
    endpoint: "/api/checkout",
    stack_trace: "TypeError: total is NaN\n    at calculateTotal (/app/src/checkout.ts:42:11)\n    at POST (/app/src/api/checkout/route.ts:18:5)",
    attributes: { source: "dashboard-test", environment: project.environment },
  };
}

/**
 * Sends a test event THROUGH the public ingestion API (real HTTP, real key authentication),
 * not by writing to the database. The caller must already be authenticated; ownership of the
 * project is checked with the caller's own RLS-scoped client before a key is minted.
 *
 * A short-lived key is created for this one request and revoked straight after, so the
 * dashboard never needs a stored plaintext key.
 */
export async function sendTestEvent(projectId: unknown, deps: Deps): Promise<TestEventResult> {
  const id = z.uuid().safeParse(projectId);
  if (!id.success) return { ok: false, message: "Invalid project." };

  const { supabase, siteUrl, fetchImpl = fetch, timeoutMs = 8_000 } = deps;

  const project = await supabase.from("projects").select("id, environment").eq("id", id.data).maybeSingle();
  if (project.error || !project.data) return { ok: false, message: "Project not found." };

  const generated = generateApiKey();
  const minted = await supabase
    .from("api_keys")
    .insert({ project_id: id.data, name: "dashboard-test (auto-revoked)", key_prefix: generated.prefix, key_hash: generated.hash })
    .select("id")
    .single();
  if (minted.error || !minted.data) return { ok: false, message: "Could not prepare the test event. Please try again." };

  try {
    const response = await fetchImpl(ingestUrl(siteUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${generated.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildTestEvent(project.data)),
      signal: AbortSignal.timeout(timeoutMs),
      // Never follow redirects while carrying a credential.
      redirect: "error",
    });

    const body = (await response.json().catch(() => null)) as {
      accepted?: number;
      results?: { incident_id: string; occurrence_count: number }[];
      error?: { message?: string };
    } | null;

    if (!response.ok) {
      return { ok: false, message: body?.error?.message ?? `The ingestion API responded with ${response.status}.` };
    }
    const first = body?.results?.[0];
    if (!first) return { ok: false, message: "The ingestion API returned an unexpected response." };
    return { ok: true, created: (body?.accepted ?? 0) > 0, incidentId: first.incident_id, occurrenceCount: first.occurrence_count };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      message: timedOut
        ? "The ingestion API did not respond in time."
        : "Could not reach the ingestion API. Check that NEXT_PUBLIC_SITE_URL points at this app.",
    };
  } finally {
    // Always revoke, even on failure; one retry because a stray active key would be a leak.
    for (let attempt = 0; attempt < 2; attempt++) {
      const { error } = await supabase.from("api_keys").update({ revoked_at: new Date().toISOString() }).eq("id", minted.data.id);
      if (!error) break;
      if (attempt === 1) console.error("[test-event] could not revoke temporary key", minted.data.id);
    }
  }
}
