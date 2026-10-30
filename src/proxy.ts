import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // api/v1/* is the key-authenticated ingestion API: it has no browser session to refresh.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health|api/v1/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
