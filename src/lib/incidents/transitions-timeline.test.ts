import { describe, expect, it } from "vitest";
import { INCIDENT_STATUSES } from "@/lib/dashboard/types";
import { buildTimeline } from "./timeline";
import { TRANSITIONS, actionsFor, canTransition } from "./transitions";
import type { ActivityEntry, EventSummary } from "./types";

describe("status transitions", () => {
  it("allows exactly the documented transitions", () => {
    const allowed = INCIDENT_STATUSES.flatMap((from) => INCIDENT_STATUSES.filter((to) => canTransition(from, to)).map((to) => `${from}->${to}`));
    expect(allowed.sort()).toEqual(["investigating->resolved", "open->investigating", "open->resolved", "resolved->open"]);
  });

  it("never allows a no-op", () => {
    for (const s of INCIDENT_STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  it("offers acknowledge+resolve for open, resolve for investigating, reopen for resolved", () => {
    expect(actionsFor("open").map((a) => a.id)).toEqual(["acknowledge", "resolve"]);
    expect(actionsFor("investigating").map((a) => a.id)).toEqual(["resolve"]);
    expect(actionsFor("resolved").map((a) => a.id)).toEqual(["reopen"]);
  });

  it("only offers actions that are valid transitions", () => {
    for (const from of INCIDENT_STATUSES) for (const a of actionsFor(from)) expect(TRANSITIONS[from]).toContain(a.to);
  });
});

const event = (id: string, at: string): EventSummary => ({
  id, projectId: "p", projectName: "proj", externalEventId: id, eventType: "TypeError", level: "error",
  message: `Message ${id}`, endpoint: "/api/x", occurredAt: at, incidentId: "i", incidentTitle: "t",
});
const activity = (id: string, at: string, over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id, fromStatus: "open", toStatus: "investigating", actor: "you", createdAt: at, ...over,
});

describe("buildTimeline", () => {
  const incident = { id: "i", firstSeenAt: "2026-10-30T08:00:00Z" };

  it("merges events and status changes newest first and ends with first seen", () => {
    const entries = buildTimeline({
      incident,
      activity: [activity("a1", "2026-10-30T10:30:00Z")],
      events: [event("e2", "2026-10-30T11:00:00Z"), event("e1", "2026-10-30T10:00:00Z")],
    });
    expect(entries.map((e) => e.id)).toEqual(["e-e2", "a-a1", "e-e1", "first-seen"]);
    expect(entries.at(-1)).toMatchObject({ kind: "first_seen", at: incident.firstSeenAt });
  });

  it("describes who changed the status", () => {
    const [mine, theirs] = buildTimeline({
      incident,
      activity: [activity("a1", "2026-10-30T10:00:00Z"), activity("a2", "2026-10-30T09:00:00Z", { actor: "teammate", fromStatus: "open", toStatus: "resolved" })],
      events: [],
    });
    expect(mine).toMatchObject({ kind: "status", title: "You changed the status", detail: "Open → Investigating", to: "investigating" });
    expect(theirs).toMatchObject({ title: "A teammate changed the status", detail: "Open → Resolved" });
  });

  it("explains an automatic reopen caused by recurrence", () => {
    const [entry] = buildTimeline({ incident, activity: [activity("a1", "2026-10-30T10:00:00Z", { actor: "system", fromStatus: "resolved", toStatus: "open" })], events: [] });
    expect(entry).toMatchObject({ title: "Reopened automatically" });
    expect(entry.detail).toMatch(/occurred again/);
  });

  it("includes event type and endpoint as detail, and handles an empty incident", () => {
    const [e] = buildTimeline({ incident, activity: [], events: [event("e1", "2026-10-30T10:00:00Z")] });
    expect(e).toMatchObject({ kind: "event", level: "error", title: "Message e1", detail: "TypeError · /api/x" });
    expect(buildTimeline({ incident, activity: [], events: [] })).toHaveLength(1);
  });

  it("orders deterministically when timestamps tie", () => {
    const at = "2026-10-30T10:00:00Z";
    const a = buildTimeline({ incident, activity: [], events: [event("b", at), event("a", at)] });
    const b = buildTimeline({ incident, activity: [], events: [event("a", at), event("b", at)] });
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
  });
});
