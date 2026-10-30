import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVENT_PARAMS,
  DEFAULT_INCIDENT_PARAMS,
  buildQuery,
  eventListHref,
  incidentListHref,
  nextSort,
  parseEventListParams,
  parseIncidentListParams,
  parseUuid,
  sinceToFrom,
} from "./params";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("parseIncidentListParams", () => {
  it("returns defaults for an empty query", () => {
    expect(parseIncidentListParams({})).toEqual({
      q: "", status: "all", severity: "all", env: "all", since: "all", sort: "last_seen", dir: "desc", page: 1, project: null,
    });
  });

  it("accepts valid values", () => {
    const p = parseIncidentListParams({ q: " cart ", status: "open", severity: "critical", env: "staging", since: "7d", sort: "occurrences", dir: "asc", page: "3", project: UUID });
    expect(p).toMatchObject({ q: "cart", status: "open", severity: "critical", env: "staging", since: "7d", sort: "occurrences", dir: "asc", page: 3, project: UUID });
  });

  it.each([
    ["status", "closed"], ["severity", "urgent"], ["env", "prod"], ["since", "1y"], ["sort", "title; drop table x"], ["dir", "sideways"],
    ["page", "0"], ["page", "-4"], ["page", "abc"], ["page", "1.5"], ["page", "999999999"], ["project", "../etc"], ["project", "not-a-uuid"],
  ])("falls back to the default for an invalid %s (%s) instead of failing", (key, value) => {
    const parsed = parseIncidentListParams({ [key]: value });
    expect(parsed[key as keyof typeof parsed]).toEqual(DEFAULT_INCIDENT_PARAMS[key as keyof typeof parsed]);
  });

  it("caps an over-long search and uses the first value of repeated params", () => {
    expect(parseIncidentListParams({ q: "x".repeat(101) }).q).toBe("");
    expect(parseIncidentListParams({ status: ["open", "resolved"] }).status).toBe("open");
  });

  it("ignores unknown parameters", () => {
    expect(parseIncidentListParams({ evil: "1", __proto__: "x" } as never)).toEqual(DEFAULT_INCIDENT_PARAMS);
  });
});

describe("parseEventListParams", () => {
  it("parses and defaults", () => {
    expect(parseEventListParams({})).toEqual(DEFAULT_EVENT_PARAMS);
    expect(parseEventListParams({ q: "x", type: "TypeError", level: "fatal", endpoint: "/api", since: "24h", page: "2", project: UUID })).toMatchObject({
      q: "x", type: "TypeError", level: "fatal", endpoint: "/api", since: "24h", page: 2, project: UUID,
    });
  });
  it("rejects invalid levels, windows and ids", () => {
    const p = parseEventListParams({ level: "loud", since: "never", project: "x", endpoint: "e".repeat(301) });
    expect(p).toMatchObject({ level: "all", since: "all", project: null, endpoint: "" });
  });
});

describe("parseUuid", () => {
  it("accepts only UUIDs", () => {
    expect(parseUuid(UUID)).toBe(UUID);
    for (const bad of ["", "abc", "' or 1=1 --", "../../x", null, undefined, 5, `${UUID}x`]) expect(parseUuid(bad)).toBeNull();
  });
});

describe("sinceToFrom", () => {
  const now = new Date("2026-10-30T12:00:00Z");
  it("computes the lower bound, or null for all time", () => {
    expect(sinceToFrom("1h", now)?.toISOString()).toBe("2026-10-30T11:00:00.000Z");
    expect(sinceToFrom("7d", now)?.toISOString()).toBe("2026-10-23T12:00:00.000Z");
    expect(sinceToFrom("30d", now)?.toISOString()).toBe("2026-09-30T12:00:00.000Z");
    expect(sinceToFrom("all", now)).toBeNull();
  });
});

describe("URL building", () => {
  it("omits defaults so URLs stay short", () => {
    expect(buildQuery({ a: "x", b: "" }, { a: "x", b: "" })).toBe("");
    expect(incidentListHref("/incidents", DEFAULT_INCIDENT_PARAMS)).toBe("/incidents");
  });

  it("round-trips non-default values", () => {
    const params = parseIncidentListParams({ q: "a b", status: "open", page: "2", project: UUID });
    const href = incidentListHref("/incidents", params);
    const back = parseIncidentListParams(Object.fromEntries(new URL(`http://x${href}`).searchParams));
    expect(back).toEqual(params);
  });

  it("applies patches (page reset, sort) without mutating the original", () => {
    const params = parseIncidentListParams({ status: "open", page: "4" });
    expect(incidentListHref("/incidents", params, { page: 1 })).toBe("/incidents?status=open");
    expect(incidentListHref("/incidents", params, { page: 5 })).toBe("/incidents?status=open&page=5");
    expect(params.page).toBe(4);
  });

  it("builds event list URLs the same way", () => {
    expect(eventListHref("/events", parseEventListParams({ level: "fatal", page: "3" }))).toBe("/events?level=fatal&page=3");
  });

  it("encodes special characters safely", () => {
    const href = incidentListHref("/incidents", parseIncidentListParams({ q: "a&b=c#d" }));
    expect(new URL(`http://x${href}`).searchParams.get("q")).toBe("a&b=c#d");
  });
});

describe("nextSort", () => {
  it("flips direction on the active column and starts at the natural order for a new one", () => {
    expect(nextSort({ sort: "last_seen", dir: "desc" }, "last_seen")).toEqual({ sort: "last_seen", dir: "asc" });
    expect(nextSort({ sort: "last_seen", dir: "asc" }, "last_seen")).toEqual({ sort: "last_seen", dir: "desc" });
    expect(nextSort({ sort: "last_seen", dir: "desc" }, "title")).toEqual({ sort: "title", dir: "asc" });
    expect(nextSort({ sort: "title", dir: "asc" }, "occurrences")).toEqual({ sort: "occurrences", dir: "desc" });
  });
});
