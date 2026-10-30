import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
// Set E2E_BASE_URL (e.g. http://localhost:3000) to test an already-running server.
// Next.js allows only one dev server per project directory, so a running `npm run dev`
// must be reused instead of started again.
const externalBaseUrl = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  globalSetup: "./tests/e2e/warmup.ts",
  reporter: "list",
  // A cold `next dev` compiles each route on first hit; give assertions room so that is not mistaken for a failure.
  expect: { timeout: 15_000 },
  use: { baseURL: externalBaseUrl ?? `http://localhost:${PORT}`, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Default: build and serve the production bundle, which is what Vercel runs and has no HMR reloads mid-test.
  // E2E_DEV=1 uses `next dev` instead (faster to start, but a cold compile can reload the page under a test).
  webServer: externalBaseUrl
    ? undefined
    : {
        command: process.env.E2E_DEV ? `npm run dev -- --port ${PORT}` : `npm run build && npm run start -- --port ${PORT}`,
        url: `http://localhost:${PORT}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 300_000,
      },
});
