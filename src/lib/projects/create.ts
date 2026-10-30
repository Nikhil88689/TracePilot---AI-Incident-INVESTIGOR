import "server-only";
import { getCurrentUser } from "@/lib/auth/session";
import { getPublicEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { createProjectSchema, type CreateProjectState } from "./schemas";
import { createProject } from "./service";

export type CreateProjectOutcome = { state: CreateProjectState; http: 200 | 201 | 400 | 401 | 409 | 500 | 503 };

/**
 * Single entry point for "create a project as the current user": authenticates, validates
 * untrusted input, then delegates to the service. Shared by the server action and /api/projects.
 */
export async function createProjectForCurrentUser(raw: unknown): Promise<CreateProjectOutcome> {
  if (!getPublicEnv()) {
    return { http: 503, state: { status: "error", message: "Supabase is not configured." } };
  }

  const user = await getCurrentUser();
  if (!user || !user.email_confirmed_at) {
    return { http: 401, state: { status: "error", message: "Your session has expired. Please sign in again." } };
  }

  const parsed = createProjectSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: NonNullable<Extract<CreateProjectState, { status: "error" }>["fieldErrors"]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (key === "name" || key === "environment") fieldErrors[key] ??= issue.message;
    }
    return { http: 400, state: { status: "error", message: "Please fix the highlighted fields.", fieldErrors } };
  }

  const supabase = await createClient();
  const result = await createProject(supabase, user.id, parsed.data);

  if (result.ok) {
    return { http: result.created ? 201 : 200, state: { status: "success", project: result.project } };
  }
  if (result.reason === "duplicate_name") {
    return {
      http: 409,
      state: { status: "error", message: result.message, fieldErrors: { name: result.message } },
    };
  }
  return { http: 500, state: { status: "error", message: result.message } };
}
