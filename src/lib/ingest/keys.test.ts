import { describe, expect, it } from "vitest";
import { API_KEY_PREFIX, extractBearerKey, generateApiKey, hashApiKey } from "./keys";

describe("generateApiKey", () => {
  it("produces a prefixed, high-entropy key and only a hash for storage", () => {
    const { key, prefix, hash } = generateApiKey();
    expect(key).toMatch(/^tp_live_[A-Za-z0-9_-]{43}$/);
    expect(prefix).toBe(key.slice(0, 12));
    expect(prefix.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashApiKey(key));
    expect(hash).not.toContain(key.slice(8));
  });

  it("never repeats across many generations (CSPRNG, 256 bits)", () => {
    const keys = new Set(Array.from({ length: 2_000 }, () => generateApiKey().key));
    expect(keys.size).toBe(2_000);
  });

  it("hashes deterministically and differently per key", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(hashApiKey(a.key)).toBe(a.hash);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("extractBearerKey", () => {
  const { key } = generateApiKey();

  it("accepts a well-formed Bearer key (scheme is case-insensitive)", () => {
    expect(extractBearerKey(`Bearer ${key}`)).toBe(key);
    expect(extractBearerKey(`bearer ${key}`)).toBe(key);
    expect(extractBearerKey(`  Bearer   ${key}  `)).toBe(key);
  });

  it.each([
    null,
    "",
    "Bearer",
    "Bearer ",
    `Basic ${"x".repeat(51)}`,
    "Bearer tp_live_short",
    `Bearer ${key}extra`,
    `Bearer ${key.slice(0, -1)}`,
    `Bearer tp_test_${"A".repeat(43)}`,
    `Bearer ${key} ${key}`,
    key, // raw key without a scheme
  ])("rejects %j before any database work", (header) => {
    expect(extractBearerKey(header)).toBeNull();
  });
});
