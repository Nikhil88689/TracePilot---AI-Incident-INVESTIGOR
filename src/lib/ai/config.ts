export type AiConfig = { apiKey: string; model: string; timeoutMs: number };

/** Null when AI analysis is not configured (no key). Timeout is clamped to what a serverless function can honour. */
export function getAiConfig(env: Record<string, string | undefined> = process.env): AiConfig | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  const timeout = Number(env.AI_TIMEOUT_MS);
  return {
    apiKey,
    model: env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-5-5",
    timeoutMs: Number.isFinite(timeout) ? Math.min(55_000, Math.max(1_000, Math.floor(timeout))) : 30_000,
  };
}
