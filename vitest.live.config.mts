import { defineConfig } from "vitest/config";

// Opt-in integration tests that talk to a real Supabase project. See tests/live/rls.test.ts.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/live/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
