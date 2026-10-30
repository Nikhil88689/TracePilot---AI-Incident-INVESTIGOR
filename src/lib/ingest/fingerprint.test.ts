import { describe, expect, it } from "vitest";
import {
  computeFingerprint,
  incidentTitle,
  normalizeEndpoint,
  normalizeMessage,
  severityForLevel,
  stackFrames,
} from "./fingerprint";

const stack = (line: number, file = "/srv/app/checkout.ts") =>
  `TypeError: boom\n    at calculateTotal (${file}:${line}:11)\n    at handler (/srv/app/route.ts:8:3)\n    at next (/srv/app/node_modules/express/lib/router.js:10:2)`;

describe("normalizeMessage", () => {
  it("strips volatile values so similar messages collapse", () => {
    const a = normalizeMessage("Order 4812 not found for user 'alice' (req 3f2b1c9a-1111-4222-8333-444455556666)");
    const b = normalizeMessage("Order 9930 not found for user 'bob' (req 0a0a0a0a-2222-4333-8444-555566667777)");
    expect(a).toBe(b);
    expect(a).toContain("<n>");
    expect(a).toContain("<str>");
    expect(a).toContain("<uuid>");
  });

  it("keeps meaningful words and distinguishes different problems", () => {
    expect(normalizeMessage("Payment declined")).not.toBe(normalizeMessage("Order not found"));
  });

  it("handles hex ids, whitespace and very long input", () => {
    expect(normalizeMessage("failed   at 0xDEADBEEF\n  id deadbeef12")).toBe("failed at <hex> id <hex>");
    expect(normalizeMessage("x".repeat(5_000)).length).toBe(300);
  });
});

describe("stackFrames", () => {
  it("returns function@file without line numbers, skipping library frames", () => {
    expect(stackFrames(stack(42))).toEqual(["calculateTotal@app/checkout.ts", "handler@app/route.ts"]);
  });

  it("is independent of line and column numbers", () => {
    expect(stackFrames(stack(42))).toEqual(stackFrames(stack(97)));
  });

  it("handles anonymous frames, file:// URLs, query strings and Windows paths", () => {
    const s = [
      "Error: x",
      "    at file:///C:/proj/src/a.js:1:2",
      "    at run (C:\\proj\\src\\b.ts:3:4)",
      "    at http://localhost:3000/_next/static/chunks/page.js?v=1:5:6",
    ].join("\n");
    const frames = stackFrames(s);
    expect(frames[0]).toBe("<anonymous>@src/a.js");
    expect(frames[1]).toBe("run@src/b.ts");
    expect(frames[2]).not.toContain("?v=1");
  });

  it("ignores bundler content hashes so deploys do not split incidents", () => {
    const a = stackFrames("E\n    at f (/app/chunks/page-3f9a1b2c4d.js:1:1)");
    const b = stackFrames("E\n    at f (/app/chunks/page-aa77bb88cc.js:1:1)");
    expect(a).toEqual(b);
  });

  it("returns nothing for missing, empty, or non-V8 stacks, and skips node internals", () => {
    expect(stackFrames(undefined)).toEqual([]);
    expect(stackFrames("")).toEqual([]);
    expect(stackFrames("Traceback (most recent call last):\n  File \"a.py\", line 3")).toEqual([]);
    expect(stackFrames("E\n    at x (node:internal/process/task_queues:95:5)\n    at y (internal/main.js:1:1)")).toEqual([]);
  });

  it("uses at most three frames", () => {
    const s = Array.from({ length: 10 }, (_, i) => `    at f${i} (/app/f${i}.ts:1:1)`).join("\n");
    expect(stackFrames(s)).toHaveLength(3);
  });
});

describe("normalizeEndpoint", () => {
  it("collapses ids and drops the query string", () => {
    expect(normalizeEndpoint("/orders/4812/items/9?x=1")).toBe("/orders/:id/items/:id");
    expect(normalizeEndpoint("/u/3f2b1c9a-1111-4222-8333-444455556666")).toBe("/u/:id");
    expect(normalizeEndpoint(undefined)).toBe("");
  });
});

describe("computeFingerprint", () => {
  const base = { event_type: "TypeError", message: "Order 1 not found", stack_trace: stack(10), endpoint: "/api/orders/1" };

  it("is deterministic and 32 hex characters", () => {
    expect(computeFingerprint(base)).toBe(computeFingerprint({ ...base }));
    expect(computeFingerprint(base)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("groups the same error across different ids, line numbers, and endpoints (stack decides)", () => {
    const other = { ...base, message: "Order 99 not found", stack_trace: stack(55), endpoint: "/api/orders/99" };
    expect(computeFingerprint(other)).toBe(computeFingerprint(base));
  });

  it("separates different error types, messages, and code locations", () => {
    const fp = computeFingerprint(base);
    expect(computeFingerprint({ ...base, event_type: "RangeError" })).not.toBe(fp);
    expect(computeFingerprint({ ...base, message: "Payment declined" })).not.toBe(fp);
    expect(computeFingerprint({ ...base, stack_trace: stack(10, "/srv/app/other.ts") })).not.toBe(fp);
  });

  it("falls back to message + normalised endpoint when there is no usable stack", () => {
    const noStack = { event_type: "Error", message: "Timeout" };
    const a = computeFingerprint({ ...noStack, endpoint: "/api/orders/1" });
    expect(computeFingerprint({ ...noStack, endpoint: "/api/orders/2" })).toBe(a);
    expect(computeFingerprint({ ...noStack, endpoint: "/api/users/2" })).not.toBe(a);
  });

  it("lets a custom fingerprint override automatic grouping, in its own namespace", () => {
    const a = computeFingerprint({ ...base, fingerprint: "checkout" });
    expect(computeFingerprint({ event_type: "Other", message: "different", fingerprint: "checkout" })).toBe(a);
    expect(a).not.toBe(computeFingerprint(base));
    expect(computeFingerprint({ event_type: "X", message: "checkout" })).not.toBe(a);
  });
});

describe("incidentTitle and severityForLevel", () => {
  it("prefixes the type unless the message already does, uses only the first line, and caps length", () => {
    expect(incidentTitle({ event_type: "TypeError", message: "x is undefined\nsecond line" })).toBe("TypeError: x is undefined");
    expect(incidentTitle({ event_type: "TypeError", message: "TypeError: already prefixed" })).toBe("TypeError: already prefixed");
    expect(incidentTitle({ event_type: "error", message: "plain" })).toBe("plain");
    expect(incidentTitle({ event_type: "e", message: "m".repeat(500) }).length).toBe(200);
  });

  it("maps levels to severities", () => {
    expect(severityForLevel("fatal")).toBe("critical");
    expect(severityForLevel("error")).toBe("high");
    expect(severityForLevel("warning")).toBe("medium");
    expect(severityForLevel("info")).toBe("low");
    expect(severityForLevel("debug")).toBe("low");
  });
});
