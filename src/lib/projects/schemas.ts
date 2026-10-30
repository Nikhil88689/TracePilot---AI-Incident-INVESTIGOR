import { z } from "zod";

export const ENVIRONMENTS = ["production", "staging", "development"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const ENVIRONMENT_LABELS: Record<Environment, { label: string; hint: string }> = {
  production: { label: "Production", hint: "Live traffic from real users." },
  staging: { label: "Staging", hint: "Pre-release testing environment." },
  development: { label: "Development", hint: "Local or shared dev work." },
};

export const projectNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a project name.")
  .max(80, "Project names can be at most 80 characters.");

export const createProjectSchema = z.object({
  name: projectNameSchema,
  environment: z.enum(ENVIRONMENTS, { error: "Choose an environment." }),
  /** Idempotency key: one per user intent, reused on retries. */
  requestId: z.uuid("Invalid request id."),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export type Project = {
  id: string;
  name: string;
  environment: Environment;
  created_at: string;
  /** True only for the simulated demo project (set by the seeder, never by clients). */
  is_demo?: boolean;
};

export type CreateProjectState =
  | { status: "idle" }
  | { status: "success"; project: Project }
  | { status: "error"; message: string; fieldErrors?: Partial<Record<"name" | "environment", string>> };
