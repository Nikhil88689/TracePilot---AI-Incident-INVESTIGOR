"use server";

import { createProjectForCurrentUser } from "./create";
import type { CreateProjectState } from "./schemas";

/** Server action used by the onboarding wizard. Input is untrusted and re-validated server-side. */
export async function createProjectAction(input: {
  name: string;
  environment: string;
  requestId: string;
}): Promise<CreateProjectState> {
  const { state } = await createProjectForCurrentUser(input);
  return state;
}
