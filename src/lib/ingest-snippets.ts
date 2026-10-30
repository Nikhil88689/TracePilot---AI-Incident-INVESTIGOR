/** Copy-paste snippets for sending events. Pure functions so they are trivially testable. */

export function ingestUrl(siteUrl: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/api/v1/events`;
}

export function samplePayload(project: { name: string; environment: string }, now = new Date()) {
  return {
    // Use a unique ID per event: re-sending the same ID is treated as a retry and ignored.
    external_event_id: "evt_example_1",
    event_type: "TypeError",
    level: "error",
    message: "TracePilot test event: checkout total was NaN",
    occurred_at: now.toISOString(),
    endpoint: "/api/checkout",
    stack_trace: "TypeError: total is NaN\n    at calculateTotal (checkout.ts:42:11)",
    attributes: { environment: project.environment, project: project.name },
  };
}

/** Single-quote-safe curl command (the JSON body is embedded in single quotes). */
export function curlCommand(url: string, payload: object): string {
  const body = JSON.stringify(payload).replace(/'/g, "'\\''");
  return [
    `curl -X POST "${url}" \\`,
    `  -H "Authorization: Bearer $TRACEPILOT_API_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${body}'`,
  ].join("\n");
}

export const SDK_INSTALL_COMMAND = "npm install ./path/to/tracepilot/sdk";

/** Node.js SDK usage. The key comes from the environment, never from source. */
export function sdkSnippet(url: string): string {
  return [
    'import { TracePilot } from "@tracepilot/node";',
    "",
    "const tracepilot = new TracePilot({",
    "  apiKey: process.env.TRACEPILOT_API_KEY,",
    `  endpoint: "${url}",`,
    '  environment: process.env.NODE_ENV,',
    "});",
    "",
    "try {",
    "  await chargeCustomer();",
    "} catch (error) {",
    '  tracepilot.captureError(error, { endpoint: "/api/checkout" });',
    "  throw error;",
    "}",
    "",
    "// Send anything still queued before the process exits.",
    "await tracepilot.close();",
  ].join("\n");
}
