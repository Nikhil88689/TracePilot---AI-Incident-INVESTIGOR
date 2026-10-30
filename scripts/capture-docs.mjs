// Regenerates the README screenshots (docs/screenshots) from a RUNNING local stack: `KEEP=1 npm run test:e2e:local -- smoke`
// leaves one up (app :3300 on the local Supabase emulator). The data shown is the built-in SIMULATED demo scenario and the
// emulator's seeded user; the AI analysis shown is the demo's pre-written one. Nothing here comes from a real deployment.
//   BASE=http://localhost:3300 EMAIL=e2e@tracepilot.test PASSWORD=... FRESH_EMAIL=fresh@tracepilot.test node scripts/capture-docs.mjs
import { chromium } from "@playwright/test";
import fs from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3300";
const OUT = "docs/screenshots";
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();

async function login(email, width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(process.env.PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/dashboard|onboarding/);
  return page;
}
const settle = async (page) => { await page.waitForLoadState("networkidle"); await page.waitForTimeout(700); };
// Element screenshots would be taken against a transparent backdrop (white), so clip the page instead.
const shot = async (page, name, target) => {
  await settle(page);
  if (target) {
    const box = await target.boundingBox();
    const pad = 12;
    await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 } });
  } else await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("saved", name);
};

// --- signed-out pages
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/");
  await shot(page, "landing-1440");
  await page.goto(BASE + "/signup");
  await shot(page, "signup-1440");
}

// --- desktop, signed in
const page = await login(process.env.EMAIL, 1440, 1280);
await page.goto(BASE + "/dashboard");
await page.getByRole("heading", { name: "Project overview" }).waitFor();
await shot(page, "dashboard-real-data-1440");
await page.goto(BASE + "/settings");
await shot(page, "settings-api-keys-1440");

// demo: start from "no demo yet" so the consent dialog can be shown, then create it
await page.goto(BASE + "/dashboard");
if (await page.getByRole("link", { name: /Open the demo/ }).count()) {
  await page.getByRole("link", { name: /Open the demo/ }).first().click();
  await page.waitForURL(/project=/);
  await page.getByRole("button", { name: /Remove demo/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove demo" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.waitForTimeout(1500);
  await page.goto(BASE + "/dashboard");
}
const open = page.getByRole("button", { name: /Try the demo/ }).first();
if (await open.count()) {
  await open.click();
  await page.getByRole("dialog").waitFor();
  await shot(page, "demo-consent-1440", page.getByRole("dialog"));
  await page.getByRole("button", { name: "Create demo project" }).click();
  await page.waitForURL(/project=/);
} else {
  await page.getByRole("link", { name: /Open the demo/ }).first().click();
  await page.waitForURL(/project=/);
}
await page.getByRole("button", { name: /Reset demo/ }).click();
await page.getByRole("dialog").getByRole("button", { name: "Reset demo" }).click();
await page.getByRole("dialog").waitFor({ state: "hidden" });
await page.waitForTimeout(1500);
const demoUrl = page.url().split("&")[0].split("#")[0];
const projectId = new URL(demoUrl).searchParams.get("project");
await page.goto(`${BASE}/dashboard?project=${projectId}&range=24h`);
await page.getByRole("img", { name: /Error rate over time/ }).waitFor();
await shot(page, "dashboard-demo-24h-1440");
await page.goto(`${BASE}/dashboard?project=${projectId}&range=7d`);
await page.getByRole("img", { name: /Error rate over time/ }).waitFor();
await shot(page, "dashboard-demo-7d-1440");

await page.goto(`${BASE}/incidents?project=${projectId}`);
await page.getByRole("table").getByRole("link", { name: /HTTP 500/ }).waitFor();
await shot(page, "incidents-list-1440");

await page.getByRole("table").getByRole("link", { name: /HTTP 500/ }).first().click();
await page.getByRole("heading", { level: 1 }).waitFor();
await page.waitForTimeout(800);
await shot(page, "incident-detail-1440");
await page.getByRole("button", { name: /Stack trace/ }).first().click();
await shot(page, "incident-stack-trace-1440", page.getByRole("region", { name: "Latest stack trace" }));
await shot(page, "incident-ai-investigation-1440", page.getByRole("complementary", { name: "Investigation" }));
await page.getByRole("button", { name: /Open evidence event/ }).first().click();
await page.getByRole("dialog").getByText("Message").waitFor();
await shot(page, "incident-evidence-dialog-1440", page.getByRole("dialog"));
await page.keyboard.press("Escape");

await page.goto(`${BASE}/events?project=${projectId}`);
await page.getByRole("list", { name: "Events" }).getByRole("button").first().click();
await page.getByRole("region", { name: "Event details" }).waitFor();
await shot(page, "events-explorer-1440");

// --- mobile
const m = await login(process.env.EMAIL, 390, 1700);
for (const [path, name] of [[`/dashboard?project=${projectId}&range=24h`, "dashboard-demo-390"], [`/incidents?project=${projectId}`, "incidents-list-390"]]) {
  await m.goto(BASE + path);
  await shot(m, name);
}
await m.goto(`${BASE}/incidents?project=${projectId}`);
await m.getByRole("table").getByRole("link", { name: /HTTP 500/ }).first().click();
await m.getByRole("heading", { level: 1 }).waitFor();
await m.waitForTimeout(800);
await shot(m, "incident-detail-390");

// --- onboarding (a user with no project yet)
if (process.env.FRESH_EMAIL) {
  const f = await login(process.env.FRESH_EMAIL, 1440, 900);
  await f.goto(BASE + "/onboarding");
  await shot(f, "onboarding-1440");
}
await browser.close();
