import { describe, expect, it } from "vitest";
import { AnalysisError, extractJson, groundOutput, parseModelOutput } from "./analysis";
import { SAMPLE_ANALYSIS, SAMPLE_EVENTS, loadSampleEvent } from "./sample";

const E1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const E2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const events = [
  { id: E1, occurredAt: "2026-10-30T10:00:00Z", message: "Cannot read x" },
  { id: E2, occurredAt: "2026-10-30T11:00:00Z", message: "Cannot read y" },
];

const valid = (over: Record<string, unknown> = {}) => ({
  summary: "Summary.",
  hypotheses: [
    { title: "H1", explanation: "E1", confidence: "high", evidence: [{ event_id: E1, why: "because" }, { event_id: E2, why: "also" }] },
    { title: "H2", explanation: "E2", confidence: "low", evidence: [{ event_id: E2, why: "maybe" }] },
  ],
  recommended_steps: [{ step: "Check the cart code", rationale: "stack points there" }, { step: "Compare releases" }],
  missing_information: ["Older events"],
  limitations: ["Only 2 events"],
  ...over,
});

describe("extractJson", () => {
  it("finds the object among prose and fences", () => {
    expect(extractJson('Here you go: {"a":1} thanks')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":{"b":2}}\n```')).toEqual({ a: { b: 2 } });
  });
  it("throws when there is no object", () => {
    expect(() => extractJson("nothing")).toThrow(SyntaxError);
    expect(() => extractJson("{broken")).toThrow();
  });
});

describe("parseModelOutput: malformed responses are rejected as retryable", () => {
  const expectInvalid = (raw: string) => {
    try {
      parseModelOutput(raw);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AnalysisError);
      expect(e).toMatchObject({ code: "invalid_response", retryable: true });
    }
  };

  it("accepts a valid response", () => {
    expect(parseModelOutput(JSON.stringify(valid())).hypotheses).toHaveLength(2);
  });

  it.each([
    ["not JSON", "I think it is the cart."],
    ["truncated JSON", '{"summary": "x", "hypotheses": ['],
    ["empty object", "{}"],
    ["array instead of object", "[]"],
  ])("rejects %s", (_n, raw) => expectInvalid(raw));

  it.each([
    ["missing summary", { summary: undefined }],
    ["empty summary", { summary: "  " }],
    ["no hypotheses", { hypotheses: [] }],
    ["too many hypotheses", { hypotheses: Array.from({ length: 6 }, () => valid().hypotheses[0]) }],
    ["no recommended steps", { recommended_steps: [] }],
    ["too many steps", { recommended_steps: Array.from({ length: 9 }, (_, i) => ({ step: `s${i}` })) }],
    ["bad confidence value", { hypotheses: [{ ...valid().hypotheses[0], confidence: "certain" }] }],
    ["numeric confidence (looks calibrated)", { hypotheses: [{ ...valid().hypotheses[0], confidence: 0.93 }] }],
    ["hypothesis with no evidence", { hypotheses: [{ ...valid().hypotheses[0], evidence: [] }] }],
    ["evidence without a reason", { hypotheses: [{ ...valid().hypotheses[0], evidence: [{ event_id: E1 }] }] }],
    ["limitations not an array", { limitations: "none" }],
    ["oversized title", { hypotheses: [{ ...valid().hypotheses[0], title: "t".repeat(201) }] }],
  ])("rejects %s", (_n, over) => expectInvalid(JSON.stringify(valid(over))));

  it("trims whitespace and allows empty missing/limitations lists", () => {
    const out = parseModelOutput(JSON.stringify(valid({ summary: "  padded  ", missing_information: [], limitations: [] })));
    expect(out.summary).toBe("padded");
    expect(out.missing_information).toEqual([]);
  });
});

describe("groundOutput: every cited event must belong to the retrieved dataset", () => {
  it("accepts valid citations and enriches them from OUR records, not from model text", () => {
    const grounded = groundOutput(parseModelOutput(JSON.stringify(valid())), events);
    expect(grounded.hypotheses[0].evidence).toEqual([
      { eventId: E1, occurredAt: "2026-10-30T10:00:00Z", message: "Cannot read x", why: "because" },
      { eventId: E2, occurredAt: "2026-10-30T11:00:00Z", message: "Cannot read y", why: "also" },
    ]);
    expect(grounded.evidenceIds.sort()).toEqual([E1, E2]);
    expect(grounded.steps).toEqual([{ step: "Check the cart code", rationale: "stack points there" }, { step: "Compare releases", rationale: null }]);
  });

  it("preserves the model's ranking order", () => {
    expect(groundOutput(parseModelOutput(JSON.stringify(valid())), events).hypotheses.map((h) => h.title)).toEqual(["H1", "H2"]);
  });

  it("rejects the WHOLE analysis if any single citation is an unknown event id", () => {
    const invented = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const output = parseModelOutput(JSON.stringify(valid({ hypotheses: [valid().hypotheses[0], { title: "H3", explanation: "e", confidence: "low", evidence: [{ event_id: invented, why: "made up" }] }] })));
    expect(() => groundOutput(output, events)).toThrow(AnalysisError);
    try {
      groundOutput(output, events);
    } catch (e) {
      expect(e).toMatchObject({ code: "invalid_evidence", retryable: true });
      expect(String((e as Error).message)).not.toContain(invented);
    }
  });

  it.each(["not-an-id", "", "../../etc/passwd", E1.toUpperCase().replace(/A/g, "a").slice(0, 10)])("rejects the malformed/unknown citation %j", (bad) => {
    if (!bad) return; // empty is rejected earlier by the schema
    const output = parseModelOutput(JSON.stringify(valid({ hypotheses: [{ title: "H", explanation: "e", confidence: "low", evidence: [{ event_id: bad, why: "x" }] }] })));
    expect(() => groundOutput(output, events)).toThrow(/not part of this incident/);
  });

  it("an event from another incident (valid UUID but not retrieved) is rejected", () => {
    const other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const output = parseModelOutput(JSON.stringify(valid({ hypotheses: [{ title: "H", explanation: "e", confidence: "low", evidence: [{ event_id: other, why: "x" }] }] })));
    expect(() => groundOutput(output, events)).toThrow(AnalysisError);
  });

  it("de-duplicates repeated citations within a hypothesis", () => {
    const output = parseModelOutput(JSON.stringify(valid({ hypotheses: [{ title: "H", explanation: "e", confidence: "low", evidence: [{ event_id: E1, why: "a" }, { event_id: E1, why: "b" }] }] })));
    expect(groundOutput(output, events).hypotheses[0].evidence).toHaveLength(1);
  });

  it("truncates long event messages stored with a citation", () => {
    const long = [{ id: E1, occurredAt: "t", message: "m".repeat(500) }];
    const output = parseModelOutput(JSON.stringify(valid({ hypotheses: [{ title: "H", explanation: "e", confidence: "low", evidence: [{ event_id: E1, why: "x" }] }] })));
    expect(groundOutput(output, long).hypotheses[0].evidence[0].message.length).toBe(200);
  });
});

describe("sample investigation", () => {
  it("is deterministic and runs through the real validation pipeline", () => {
    expect(SAMPLE_ANALYSIS.hypotheses.length).toBeGreaterThanOrEqual(2);
    expect(SAMPLE_ANALYSIS.recommendedSteps.length).toBeGreaterThan(0);
    expect(SAMPLE_ANALYSIS.missingInformation.length).toBeGreaterThan(0);
    expect(SAMPLE_ANALYSIS.limitations.length).toBeGreaterThan(0);
  });

  it("is unmistakably marked as a sample and never claims a model produced it", () => {
    expect(SAMPLE_ANALYSIS.sample).toBe(true);
    expect(SAMPLE_ANALYSIS.model).toMatch(/no model was called/);
    expect(SAMPLE_ANALYSIS.usage).toBeNull();
    expect(SAMPLE_ANALYSIS.id).toBe("sample");
  });

  it("only cites its own sample events, all of which can be opened", () => {
    for (const h of SAMPLE_ANALYSIS.hypotheses) for (const e of h.evidence) expect(loadSampleEvent(e.eventId)).not.toBeNull();
    expect(loadSampleEvent("nope")).toBeNull();
    expect(SAMPLE_EVENTS.every((e) => e.projectName === "sample-storefront")).toBe(true);
  });

  it("does not overclaim: uses hedged language and states limitations", () => {
    const text = JSON.stringify(SAMPLE_ANALYSIS).toLowerCase();
    expect(text).not.toMatch(/\b(definitely|certainly|guaranteed|proven)\b/);
    expect(SAMPLE_ANALYSIS.limitations.join(" ")).toMatch(/nothing was reproduced or verified/i);
  });
});
