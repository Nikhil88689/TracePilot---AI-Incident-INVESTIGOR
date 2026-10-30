import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getPublicEnv } from "@/lib/env";
import { createProjectForCurrentUser } from "@/lib/projects/create";
import { listProjects } from "@/lib/projects/service";
import { isCrossSiteRequest } from "@/lib/security/same-origin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

/** Lists the signed-in user's projects. RLS guarantees no other user's rows are visible. */
export async function GET() {
  if (!getPublicEnv()) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const result = await listProjects(await createClient());
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: 500 });
  return NextResponse.json({ projects: result.projects });
}

/** Idempotent create: retrying with the same `requestId` returns the original project (200). */
export async function POST(request: Request) {
  // Cookie-authenticated and state-changing: refuse requests that originate from another site.
  if (isCrossSiteRequest(request)) return NextResponse.json({ error: "Cross-site requests are not allowed" }, { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON" }, { status: 400 });
  }

  const { state, http } = await createProjectForCurrentUser(body);
  if (state.status === "success") return NextResponse.json({ project: state.project }, { status: http });
  if (state.status === "error") {
    return NextResponse.json({ error: state.message, fieldErrors: state.fieldErrors }, { status: http });
  }
  return NextResponse.json({ error: "Unexpected state" }, { status: 500 });
}
