import type { IncidentStatus, Severity } from "@/lib/dashboard/types";

export type IncidentSummary = {
  id: string;
  projectId: string;
  projectName: string;
  environment: string;
  title: string;
  severity: Severity;
  status: IncidentStatus;
  occurrenceCount: number;
  /** ISO 8601 */
  firstSeenAt: string;
  /** ISO 8601 */
  lastSeenAt: string;
  endpoint: string | null;
};

export type IncidentDetail = IncidentSummary & { fingerprint: string; resolvedAt: string | null };

export type IncidentCounts = { unresolved: number; critical: number; recentlyResolved: number; total: number };

export type ActivityEntry = {
  id: string;
  fromStatus: IncidentStatus | null;
  toStatus: IncidentStatus | null;
  actor: "you" | "system" | "teammate";
  createdAt: string;
};

export type HistogramBucket = { start: string; end: string; count: number };

export type EventLevel = "debug" | "info" | "warning" | "error" | "fatal";

export type EventSummary = {
  id: string;
  projectId: string;
  projectName: string;
  externalEventId: string;
  eventType: string;
  level: EventLevel;
  message: string;
  endpoint: string | null;
  occurredAt: string;
  incidentId: string | null;
  incidentTitle: string | null;
};

export type EventDetail = EventSummary & {
  stackTrace: string | null;
  attributes: Record<string, unknown>;
};

export type EventFilterOptions = { eventTypes: string[]; endpoints: string[] };

export type Page<T> = { items: T[]; total: number; page: number; pageCount: number; pageSize: number };

export type AnalysisStatus = "pending" | "complete" | "failed";

/** One stored event a hypothesis cites, with the model's explanation of why it supports the hypothesis. */
export type AnalysisEvidence = { eventId: string; occurredAt: string; message: string; why: string };

export type AnalysisHypothesis = {
  title: string;
  explanation: string;
  /** The model's own rough estimate. NOT a calibrated probability. */
  confidence: "low" | "medium" | "high";
  /** Every entry is an event that was actually retrieved and shown to the model. */
  evidence: AnalysisEvidence[];
};

export type AnalysisStep = { step: string; rationale: string | null };

export type Analysis = {
  id: string;
  status: AnalysisStatus;
  summary: string | null;
  /** Ranked: index 0 is the model's most likely hypothesis. */
  hypotheses: AnalysisHypothesis[];
  recommendedSteps: AnalysisStep[];
  missingInformation: string[];
  limitations: string[];
  /** 0-based indexes into recommendedSteps the developer has ticked off. */
  completedSteps: number[];
  /** How many stored events the model was shown. */
  inputEventCount: number | null;
  model: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  errorMessage: string | null;
  errorCode: string | null;
  /** For failed analyses: whether trying again may succeed. */
  retryable: boolean;
  createdAt: string;
  completedAt: string | null;
  /** True only for the built-in generic sample; never set for stored analyses. */
  sample?: boolean;
  /** True for the pre-written analysis seeded with the demo project (no model was called). */
  simulated?: boolean;
};
