import { z } from "zod";
import type { AnalysisHypothesis, AnalysisStep } from "@/lib/incidents/types";

/**
 * The contract between the model and TracePilot, plus the checks that make its output safe to
 * store and show. Pure and client-safe: the sample investigation runs through the very same code.
 */

export const LIMITS = { hypotheses: 5, evidencePerHypothesis: 12, steps: 8, notes: 8 } as const;

export type AnalysisErrorCode =
  | "invalid_response"
  | "invalid_evidence"
  | "no_evidence"
  | "no_events"
  | "refused"
  | "timeout"
  | "rate_limited"
  | "provider_unavailable"
  | "provider_error"
  | "model_unavailable"
  | "provider_rejected"
  | "auth"
  | "save_failed"
  | "unknown";

/** A failure with a user-safe message and a hint about whether retrying can help. */
export class AnalysisError extends Error {
  constructor(
    public readonly code: AnalysisErrorCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AnalysisError";
  }
}

const text = (max: number) => z.string().trim().min(1).max(max);

export const modelOutputSchema = z.object({
  summary: text(2_000),
  hypotheses: z
    .array(
      z.object({
        title: text(200),
        explanation: text(2_000),
        confidence: z.enum(["low", "medium", "high"]),
        evidence: z
          .array(z.object({ event_id: text(64), why: text(600) }))
          .min(1)
          .max(LIMITS.evidencePerHypothesis),
      }),
    )
    .min(1)
    .max(LIMITS.hypotheses),
  recommended_steps: z.array(z.object({ step: text(400), rationale: z.string().trim().max(400).optional() })).min(1).max(LIMITS.steps),
  missing_information: z.array(text(400)).max(LIMITS.notes),
  limitations: z.array(text(400)).max(LIMITS.notes),
});

export type ModelOutput = z.infer<typeof modelOutputSchema>;

/** Extracts the first JSON object from model text, tolerating a code fence or stray prose. */
export function extractJson(raw: string): unknown {
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) throw new SyntaxError("no JSON object");
  return JSON.parse(stripped.slice(start, end + 1));
}

/** Parses and validates the model's reply. Anything malformed becomes a retryable `invalid_response`. */
export function parseModelOutput(raw: string): ModelOutput {
  try {
    return modelOutputSchema.parse(extractJson(raw));
  } catch {
    throw new AnalysisError("invalid_response", "The AI response was not in the expected format. Try again.", true);
  }
}

export type EvidenceRef = { id: string; occurredAt: string; message: string };

export type Grounded = {
  summary: string;
  hypotheses: AnalysisHypothesis[];
  steps: AnalysisStep[];
  missing: string[];
  limitations: string[];
  evidenceIds: string[];
};

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/**
 * Verifies that every cited event id belongs to the retrieved dataset. If the model cites even one id
 * that was never shown to it, the whole analysis is rejected: a fabricated reference means the rest of
 * the output cannot be trusted either. Valid output is turned into stored form, enriching each
 * citation from our own records (never from model text).
 */
export function groundOutput(output: ModelOutput, events: EvidenceRef[]): Grounded {
  const byId = new Map(events.map((e) => [e.id, e]));
  const used = new Set<string>();

  const hypotheses = output.hypotheses.map((h): AnalysisHypothesis => {
    const seen = new Set<string>();
    const evidence = h.evidence.flatMap((cite) => {
      const event = byId.get(cite.event_id);
      if (!event) {
        throw new AnalysisError(
          "invalid_evidence",
          "The AI cited an event that is not part of this incident's evidence, so the analysis was discarded. Try again.",
          true,
        );
      }
      if (seen.has(event.id)) return [];
      seen.add(event.id);
      used.add(event.id);
      return [{ eventId: event.id, occurredAt: event.occurredAt, message: clip(event.message, 200), why: cite.why }];
    });
    return { title: h.title, explanation: h.explanation, confidence: h.confidence, evidence };
  });

  return {
    summary: output.summary,
    hypotheses,
    steps: output.recommended_steps.map((s) => ({ step: s.step, rationale: s.rationale?.trim() || null })),
    missing: output.missing_information,
    limitations: output.limitations,
    evidenceIds: [...used],
  };
}
