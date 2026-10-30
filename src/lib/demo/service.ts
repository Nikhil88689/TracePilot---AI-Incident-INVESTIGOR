import { z } from "zod";
import { DataError, type RpcClient } from "@/lib/incidents/queries";

const seedResult = z.object({ project_id: z.uuid(), created: z.boolean() });

export type SeedDemoResult = { ok: true; projectId: string; created: boolean } | { ok: false; reason: "name_taken" | "not_signed_in" };

/**
 * Creates (or returns) the caller's own simulated demo project. Idempotent: calling it again returns
 * the existing project unchanged. `reset` deletes the demo project and rebuilds it against a new demo
 * clock. It only ever creates or removes a project flagged as demo that the caller owns; it never
 * writes into any of their real projects.
 */
export async function seedDemo(db: RpcClient, opts: { reset?: boolean; now?: Date } = {}): Promise<SeedDemoResult> {
  const { data, error } = await db.rpc("seed_demo_project", {
    p_anchor: (opts.now ?? new Date()).toISOString(),
    p_reset: opts.reset === true,
  });
  if (error) {
    if (error.code === "23505") return { ok: false, reason: "name_taken" };
    if (error.code === "28000") return { ok: false, reason: "not_signed_in" };
    throw new DataError("seed_demo_project", error.code);
  }
  const parsed = seedResult.safeParse(data);
  if (!parsed.success) throw new DataError("seed_demo_project", "bad_shape");
  return { ok: true, projectId: parsed.data.project_id, created: parsed.data.created };
}

/** Deletes the caller's demo project and everything under it. Returns whether one existed. */
export async function removeDemo(db: RpcClient): Promise<boolean> {
  const { data, error } = await db.rpc("remove_demo_project", {});
  if (error) throw new DataError("remove_demo_project", error.code);
  return data === true;
}
