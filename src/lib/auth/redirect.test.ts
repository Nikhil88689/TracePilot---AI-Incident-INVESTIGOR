import { describe, expect, it } from "vitest";
import { safeNextPath } from "./redirect";

describe("safeNextPath", () => {
  it("keeps same-origin relative paths", () => {
    expect(safeNextPath("/incidents/123?tab=events")).toBe("/incidents/123?tab=events");
  });

  it.each(["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "evil"])(
    "rejects %s",
    (value) => {
      expect(safeNextPath(value)).toBe("/dashboard");
    },
  );

  it("falls back when missing", () => {
    expect(safeNextPath(null)).toBe("/dashboard");
    expect(safeNextPath(undefined, "/x")).toBe("/x");
  });
});
