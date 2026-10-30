import type { Analysis, EventDetail } from "@/lib/incidents/types";
import { groundOutput, parseModelOutput } from "./analysis";

/**
 * A fixed, fictional "sample investigation": seeded logs plus a canned model reply, pushed through
 * the SAME parsing and evidence verification as a real analysis. It makes no provider call, is fully
 * deterministic, and is always labelled as a sample in the UI. It is not a diagnosis of anything real.
 */

const P = "00000000-0000-4000-8000-00000000000a";
const I = "00000000-0000-4000-8000-0000000000b1";

const base = (n: number, at: string, over: Partial<EventDetail>): EventDetail => ({
  id: `5a3b1e00-0000-4000-8000-${String(n).padStart(12, "0")}`,
  projectId: P,
  projectName: "sample-storefront",
  externalEventId: `sample_evt_${n}`,
  eventType: "TypeError",
  level: "error",
  message: "Cannot read properties of undefined (reading 'total')",
  endpoint: "POST /api/checkout",
  occurredAt: at,
  incidentId: I,
  incidentTitle: "TypeError: Cannot read properties of undefined (reading 'total')",
  stackTrace:
    "TypeError: Cannot read properties of undefined (reading 'total')\n    at calculateTotal (/app/src/checkout/totals.ts:42:19)\n    at applyPromo (/app/src/checkout/promo.ts:17:10)\n    at POST (/app/src/app/api/checkout/route.ts:23:5)",
  attributes: { release: "2026.01.12-a", cartItems: 0, promoCode: "WINTER25" },
  ...over,
});

export const SAMPLE_EVENTS: EventDetail[] = [
  base(1, "2026-01-12T09:14:03.000Z", {}),
  base(2, "2026-01-12T09:31:40.000Z", { attributes: { release: "2026.01.12-a", cartItems: 0, promoCode: "WINTER25" } }),
  base(3, "2026-01-12T10:02:12.000Z", { attributes: { release: "2026.01.12-a", cartItems: 0, promoCode: "SPRING10" } }),
  base(4, "2026-01-12T10:20:55.000Z", {
    message: "Cannot read properties of undefined (reading 'discount')",
    stackTrace:
      "TypeError: Cannot read properties of undefined (reading 'discount')\n    at applyPromo (/app/src/checkout/promo.ts:21:34)\n    at POST (/app/src/app/api/checkout/route.ts:23:5)",
    attributes: { release: "2026.01.12-a", cartItems: 0, promoCode: "WINTER25" },
  }),
  base(5, "2026-01-12T10:41:09.000Z", { attributes: { release: "2026.01.12-a", cartItems: 0, promoCode: "WINTER25" } }),
];

const SAMPLE_REPLY = {
  summary:
    "All five sampled events fail inside the checkout totals calculation, and every one of them was recorded for a cart with zero items and a promo code applied. The evidence points to the promo path running against an empty cart summary, but the events alone cannot show what changed.",
  hypotheses: [
    {
      title: "A promo code is applied to an empty cart, leaving the cart summary undefined",
      explanation:
        "Each failure happens in calculateTotal/applyPromo while cartItems is 0 and a promoCode is set. If the empty-cart case returns no summary object, reading its total or discount would throw exactly this error.",
      confidence: "medium",
      evidence: [
        { event_id: SAMPLE_EVENTS[0].id, why: "The earliest event already shows the failure with cartItems 0 and promoCode WINTER25." },
        { event_id: SAMPLE_EVENTS[3].id, why: "A different property (discount) fails in applyPromo, again with an empty cart, which fits a missing summary object." },
        { event_id: SAMPLE_EVENTS[2].id, why: "A second promo code (SPRING10) fails identically, so it is not specific to one code." },
      ],
    },
    {
      title: "A change released as 2026.01.12-a introduced the failure",
      explanation:
        "Every sampled event carries release 2026.01.12-a, and the incident's first event falls on the same day. That is consistent with a regression, but all events share a release, so the data cannot distinguish a regression from a long-standing bug that is now being triggered.",
      confidence: "low",
      evidence: [
        { event_id: SAMPLE_EVENTS[0].id, why: "First occurrence, already on release 2026.01.12-a." },
        { event_id: SAMPLE_EVENTS[4].id, why: "The most recent event is still on the same release." },
      ],
    },
  ],
  recommended_steps: [
    { step: "Read applyPromo (promo.ts) and calculateTotal (totals.ts) and check what they return for an empty cart.", rationale: "Both stack traces point at these functions." },
    { step: "Reproduce locally with an empty cart and a valid promo code in a test environment.", rationale: "Every sampled event had cartItems 0 with a promo code." },
    { step: "Compare the checkout code between the previous release and 2026.01.12-a.", rationale: "To check whether this path changed in that release." },
    { step: "Check whether checkout requests with cartItems 0 occurred before this release.", rationale: "Separates a new regression from an old bug that is newly reachable." },
  ],
  missing_information: [
    "Events from before release 2026.01.12-a, to see whether the failure is new.",
    "The request payload (cart contents and promo details) beyond the attributes captured.",
    "Source code for promo.ts and totals.ts.",
  ],
  limitations: [
    "Only 5 events were provided, and all share one release.",
    "No deployment or configuration history was available.",
    "This is a hypothesis from log evidence; nothing was reproduced or verified.",
  ],
};

/** The stored-shape analysis for the sample, produced by the real validation + grounding pipeline. */
export function buildSampleAnalysis(): Analysis {
  const grounded = groundOutput(
    parseModelOutput(JSON.stringify(SAMPLE_REPLY)),
    SAMPLE_EVENTS.map((e) => ({ id: e.id, occurredAt: e.occurredAt, message: e.message })),
  );
  return {
    id: "sample",
    status: "complete",
    summary: grounded.summary,
    hypotheses: grounded.hypotheses,
    recommendedSteps: grounded.steps,
    missingInformation: grounded.missing,
    limitations: grounded.limitations,
    completedSteps: [],
    inputEventCount: SAMPLE_EVENTS.length,
    model: "sample (no model was called)",
    usage: null,
    errorMessage: null,
    errorCode: null,
    retryable: false,
    createdAt: "2026-01-12T11:00:00.000Z",
    completedAt: "2026-01-12T11:00:00.000Z",
    sample: true,
  };
}

export const SAMPLE_ANALYSIS: Analysis = buildSampleAnalysis();

export function loadSampleEvent(id: string): EventDetail | null {
  return SAMPLE_EVENTS.find((e) => e.id === id) ?? null;
}
