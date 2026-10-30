import { describe, expect, it } from "vitest";
import { SDK_INSTALL_COMMAND, curlCommand, ingestUrl, samplePayload, sdkSnippet } from "./ingest-snippets";

describe("ingest snippets", () => {
  it("builds the events endpoint without double slashes", () => {
    expect(ingestUrl("https://app.example.com/")).toBe("https://app.example.com/api/v1/events");
    expect(ingestUrl("http://localhost:3000")).toBe("http://localhost:3000/api/v1/events");
  });

  it("builds a sample payload that satisfies the API contract", () => {
    const now = new Date("2026-10-29T12:00:00Z");
    expect(samplePayload({ name: "web", environment: "staging" }, now)).toMatchObject({
      external_event_id: expect.stringMatching(/^[A-Za-z0-9._:-]+$/),
      event_type: "TypeError",
      level: "error",
      occurred_at: "2026-10-29T12:00:00.000Z",
      attributes: { environment: "staging" },
    });
  });

  it("embeds valid JSON in the curl command, even with apostrophes", () => {
    const cmd = curlCommand("https://x/api/v1/events", { message: "it's broken" });
    expect(cmd).toContain("Authorization: Bearer $TRACEPILOT_API_KEY");
    expect(cmd).toContain("it'\\''s broken");
  });

  it("reads the key from the environment and never embeds a real one", () => {
    const snippet = sdkSnippet("https://x/api/v1/events");
    expect(snippet).toContain("process.env.TRACEPILOT_API_KEY");
    expect(snippet).toContain("https://x/api/v1/events");
    expect(snippet).not.toMatch(/tp_live_[A-Za-z0-9_-]{10,}/);
    expect(SDK_INSTALL_COMMAND).toMatch(/^npm install/);
  });
});
