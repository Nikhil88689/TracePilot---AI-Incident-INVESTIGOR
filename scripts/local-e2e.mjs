// Runs the WHOLE app, signed in, in a real browser, with no accounts: starts the local Supabase emulator
// (tests/emulator, real embedded Postgres + all migrations), builds and serves the production bundle against
// it, runs Playwright, and tears everything down. Not Supabase: see tests/emulator/serve.mts for what it covers.
//
//   npm run test:e2e:local                 all specs, signed in as the seeded user
//   npm run test:e2e:local -- critical-flow   only matching specs
//   KEEP=1 npm run test:e2e:local          leave the stack running afterwards (emulator :54321, app :3300)
import { spawn } from "node:child_process";

const APP_PORT = 3300;
const EMU_PORT = 54321;
const env = {
  ...process.env,
  NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${EMU_PORT}`,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "emulator-anon-key",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
  SUPABASE_SERVICE_ROLE_KEY: "emulator-service-key",
  NEXT_PUBLIC_SITE_URL: `http://localhost:${APP_PORT}`,
  // Never inherits a real key from .env.local: AI goes to the emulator's deterministic stub (not a model).
  ANTHROPIC_API_KEY: "emulator-fake-key",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${EMU_PORT}/anthropic`,
  EMULATOR_PORT: String(EMU_PORT),
};
const children = [];
const run = (cmd, args, opts = {}) => {
  const child = spawn(cmd, args, { stdio: "inherit", shell: true, env, ...opts });
  children.push(child);
  return child;
};
const done = (child) => new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
const waitFor = async (url, ms = 120_000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fetch(url).then((r) => r.ok).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${url}`);
};
// Children are started through a shell (npx), so killing the shell pid alone leaves node running: kill by listening port.
const killPort = (port) =>
  new Promise((resolve) => {
    const child =
      process.platform === "win32"
        ? spawn("powershell", ["-NoProfile", "-Command", `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`], { stdio: "ignore" })
        : spawn("sh", ["-c", `lsof -ti tcp:${port} | xargs -r kill`], { stdio: "ignore" });
    child.on("exit", resolve);
    child.on("error", resolve);
  });

let code = 1;
try {
  run("npx", ["tsx", "tests/emulator/serve.mts"], { stdio: ["ignore", "ignore", "inherit"] });
  await waitFor(`http://127.0.0.1:${EMU_PORT}/emulator/health`);
  if ((await done(run("npm", ["run", "build"], { stdio: ["ignore", "ignore", "inherit"] }))) !== 0) throw new Error("build failed");
  run("npx", ["next", "start", "-p", String(APP_PORT)], { stdio: ["ignore", "ignore", "inherit"] });
  await waitFor(`http://localhost:${APP_PORT}/api/health`);
  code = await done(
    run("npx", ["playwright", "test", "--workers=1", ...process.argv.slice(2)], {
      env: { ...env, E2E_BASE_URL: `http://localhost:${APP_PORT}`, E2E_EMAIL: "e2e@tracepilot.test", E2E_PASSWORD: "Tracepilot-E2E-1", E2E_FRESH_EMAIL: "fresh@tracepilot.test" },
    }),
  );
} catch (e) {
  console.error(e.message);
} finally {
  if (process.env.KEEP) console.log(`stack left running: emulator :${EMU_PORT}, app :${APP_PORT}`);
  else {
    children.forEach((c) => c.kill());
    await Promise.all([killPort(APP_PORT), killPort(EMU_PORT)]); // must finish before process.exit below
  }
}
process.exit(code);
