import { describe, expect, it } from "vitest";
import { isCrossSiteRequest, isJsonRequest } from "./same-origin";

const req = (headers: Record<string, string>) => new Request("https://app.example.com/x", { method: "POST", headers });

describe("isCrossSiteRequest", () => {
  it("allows same-origin and header-less requests", () => {
    expect(isCrossSiteRequest(req({ origin: "https://app.example.com", host: "app.example.com" }))).toBe(false);
    expect(isCrossSiteRequest(req({ "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(isCrossSiteRequest(req({}))).toBe(false);
  });
  it("rejects other origins, 'null', garbage and Sec-Fetch-Site: cross-site", () => {
    expect(isCrossSiteRequest(req({ origin: "https://evil.example", host: "app.example.com" }))).toBe(true);
    expect(isCrossSiteRequest(req({ origin: "https://app.example.com.evil.example", host: "app.example.com" }))).toBe(true);
    expect(isCrossSiteRequest(req({ origin: "null", host: "app.example.com" }))).toBe(true);
    expect(isCrossSiteRequest(req({ "sec-fetch-site": "cross-site" }))).toBe(true);
  });
});

describe("isJsonRequest", () => {
  it("accepts only application/json", () => {
    expect(isJsonRequest(req({ "content-type": "application/json; charset=utf-8" }))).toBe(true);
    for (const t of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""]) expect(isJsonRequest(req(t ? { "content-type": t } : {}))).toBe(false);
  });
});
