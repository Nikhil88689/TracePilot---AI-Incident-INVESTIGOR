import { describe, expect, it } from "vitest";
import { parseIngestBody } from "./schemas";

const NOW = new Date("2026-10-29T12:00:00Z");
const valid = (over: Record<string, unknown> = {}) => ({
  external_event_id: "evt_1",
  message: "boom",
  occurred_at: "2026-10-29T11:59:00Z",
  ...over,
});

describe("parseIngestBody", () => {
  it("accepts a single event and applies defaults", () => {
    const r = parseIngestBody(valid(), NOW);
    expect(r.ok && r.events[0]).toMatchObject({ event_type: "error", level: "error", message: "boom" });
  });

  it("accepts a batch and reports the index of the offending event", () => {
    expect(parseIngestBody({ events: [valid(), valid({ external_event_id: "evt_2" })] }, NOW).ok).toBe(true);
    const bad = parseIngestBody({ events: [valid(), valid({ level: "nope" })] }, NOW);
    expect(!bad.ok && bad.issues[0].path).toBe("events[1].level");
  });

  it("drops unknown fields, including any client-supplied project id", () => {
    const r = parseIngestBody(valid({ project_id: "11111111-1111-4111-8111-111111111111", extra: 1 }), NOW);
    expect(r.ok && Object.keys(r.events[0])).not.toContain("project_id");
    expect(r.ok && Object.keys(r.events[0])).not.toContain("extra");
  });

  it("enforces the batch limit with a distinct reason", () => {
    const r = parseIngestBody({ events: Array.from({ length: 51 }, (_, i) => valid({ external_event_id: `e${i}` })) }, NOW);
    expect(!r.ok && r.reason).toBe("too_many_events");
    expect(parseIngestBody({ events: Array.from({ length: 50 }, (_, i) => valid({ external_event_id: `e${i}` })) }, NOW).ok).toBe(true);
  });

  it.each([null, "str", 1, [], [valid()], { events: [] }, { events: {} }])("rejects non-event bodies: %j", (body) => {
    expect(parseIngestBody(body, NOW).ok).toBe(false);
  });

  it.each([
    ["epoch seconds", 1761739140],
    ["date only", "2026-10-29"],
    ["no timezone", "2026-10-29T11:59:00"],
    ["garbage", "soon"],
    ["impossible day", "2026-02-30T00:00:00Z"],
    ["future (>5 min)", "2026-10-29T12:06:00Z"],
    ["too old (>30 days)", "2026-09-01T00:00:00Z"],
  ])("rejects timestamp: %s", (_label, value) => {
    expect(parseIngestBody(valid({ occurred_at: value }), NOW).ok).toBe(false);
  });

  it("accepts offsets and small forward skew", () => {
    expect(parseIngestBody(valid({ occurred_at: "2026-10-29T17:29:00+05:30" }), NOW).ok).toBe(true);
    expect(parseIngestBody(valid({ occurred_at: "2026-10-29T12:04:00Z" }), NOW).ok).toBe(true);
  });

  it("rejects NUL bytes anywhere Postgres could not store them", () => {
    expect(parseIngestBody(valid({ message: "a\u0000b" }), NOW).ok).toBe(false);
    expect(parseIngestBody(valid({ endpoint: "/a\u0000" }), NOW).ok).toBe(false);
    expect(parseIngestBody(valid({ stack_trace: "\u0000" }), NOW).ok).toBe(false);
    expect(parseIngestBody(valid({ attributes: { "k\u0000": 1 } }), NOW).ok).toBe(false);
    expect(parseIngestBody(valid({ attributes: { nested: { v: "x\u0000" } } }), NOW).ok).toBe(false);
  });

  it("bounds attributes by keys, depth and serialized size", () => {
    expect(parseIngestBody(valid({ attributes: { a: { b: { c: { d: 1 } } } } }), NOW).ok).toBe(true);
    expect(parseIngestBody(valid({ attributes: { a: { b: { c: { d: { e: { f: 1 } } } } } } }), NOW).ok).toBe(false);
    const manyKeys = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, 1]));
    expect(parseIngestBody(valid({ attributes: manyKeys }), NOW).ok).toBe(false);
    expect(parseIngestBody(valid({ attributes: { big: "x".repeat(17_000) } }), NOW).ok).toBe(false);
  });

  it("caps the number of reported issues", () => {
    const events = Array.from({ length: 50 }, () => ({ message: "" }));
    const r = parseIngestBody({ events }, NOW);
    expect(!r.ok && r.issues.length).toBeLessThanOrEqual(20);
  });
});
