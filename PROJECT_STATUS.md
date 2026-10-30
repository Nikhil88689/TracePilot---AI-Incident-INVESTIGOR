# TracePilot — Project Status

_Last updated: 2026-10-30 · Milestone 10: final release review_

Docs: [README.md](README.md) (overview, screenshots, architecture, setup, env reference, API, AI design, testing, benchmark, deployment, trade-offs) · [INTERVIEW_GUIDE.md](INTERVIEW_GUIDE.md).

**Not deployed.** I cannot reach your Vercel, Supabase or Anthropic accounts. Everything below was verified locally, and the "Not verified" section lists what only you can verify.

## What this review did

I built a **local Supabase emulator** (`tests/emulator/serve.mts`): a small GoTrue/PostgREST-shaped HTTP server in front of the real embedded Postgres 17 with all seven migrations, plus a deterministic stub standing in for the Anthropic API. For the first time that let me run the entire signed-in app in a real browser, look at it, and run every signed-in e2e spec (`npm run test:e2e:local`). It is **not Supabase** (no email delivery, OAuth, pooling, or real latency) and the stub is **not a model**. Doing this found real defects that unit, integration and public-page tests had not:

| Found in the real browser | Fix | Regression test |
| --- | --- | --- |
| **Command palette crashed the whole page on open** (Ctrl+K or the search button): `CommandDialog` rendered cmdk items without the `<Command>` root | wrapped in `<Command>` | `command-menu.test.tsx` (5 tests; verified to fail with the exact production error without the fix) |
| Project menu stayed open over the page after choosing a project | `closeOnClick` on radio items | dashboard render test |
| Quick second click after Acknowledge sent a stale status and produced a misleading "Someone already changed this" toast (buttons re-enabled before the refresh landed) | buttons stay disabled until the refresh completes | e2e status transition |
| Opening an evidence event right after an analysis finished closed the dialog (panel remounted on refresh) | no refresh after a successful run | `ai-components.test.tsx`, e2e critical flow |
| Health banner said **"Critical: error rate 100%"** for 1 error out of 1 event | rates judged only with ≥ 20 events ("Limited data"), unresolved critical incidents still reported | `deriveHealth` tests |
| Error-rate chart: odd 115% axis, a lone data point drew nothing, deploy/rollback labels overprinted | nice 0–100% axis, dot for isolated points, staggered marker labels | chart tests |
| Severity legend clipped on mobile | auto-height card on small screens | e2e overflow checks |
| Times in charts, health bar and key list used the viewer's/server's time zone (inconsistent with "UTC everywhere") | UTC everywhere, seconds shown for short spans | — |
| "1 errors of 1 events", "1 projects", "All 1 events"; events page said "error event" while listing all levels; raw UUID in the mobile header; "Collapse" looked selected | copy and formatting fixes | updated assertions |
| No error boundaries: any render error showed Next's unstyled white default page | `(app)/error.tsx` (keeps the shell) and `global-error.tsx` | `error.test.tsx` |
| "Try the demo" was only reachable from the project menu | button on the dashboard header | e2e demo walkthrough |

Housekeeping: removed unused boilerplate (`public/*.svg`, an old script), fixed e2e specs that assumed fresh state, fixed screenshots being written to the repo root, `sdk/node_modules` now gitignored, `.env.example` re-checked (placeholders only).

## Commands run and results (this session, local machine)

| Command | Result |
| --- | --- |
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm test` | **529 passed** (38 files) |
| `npm run test:integration` | **242 passed** (9 files), real Postgres 17, all 7 migrations, `supabase/verify.sql` |
| `npm run build` | clean (includes `global-error.tsx`) |
| `npm run test:e2e` (production build on :3100, signed-out) | **57 passed, 12 skipped** (signed-in specs need credentials) |
| `npm run test:e2e:local` (production build + emulator, signed in) | **69 passed, 0 skipped**, includes the critical flow and the demo walkthrough |
| `cd sdk && npm run build` | clean |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `node scripts/bench-ingest.mjs` ×2 | see below |

**Benchmark (real HTTP, one laptop, everything co-located).** Windows 11, AMD Ryzen 5 5600H (12 logical cores), 15 GB, Node 24; load generator, `next start`, the emulator (3 HTTP calls per ingest) and embedded Postgres all on one machine; no network, TLS, or cold starts.

| Workload | Throughput | p50 / p95 / p99 | Errors |
| --- | --- | --- | --- |
| 3,000 events, 1 per request, 16 concurrent, 10 keys | 231 req/s | 65 / 103 / 129 ms | 0 % (all 201) |
| 3,000 events, 10 per request, 16 concurrent, 10 keys | 175 req/s = 1,746 events/s | 79 / 154 / 316 ms | 0 % (all 201) |

Afterwards the database held exactly **5 incidents × 1,200 occurrences** for the 6,000 events (no lost or double-counted updates under 16 concurrent writers). This is **not** a load test of Vercel or Supabase and says nothing about sustained load.

## Deployment blockers

No code-level blockers I know of. Before you can ship you must do the manual steps; none can be done from here:
1. Apply all **seven** migrations to Supabase and run `supabase/verify.sql` (every row `ok = true`). The cost-guard fix is migration 7.
2. Set Supabase redirect URLs and the Vercel environment variables (README → Deploy to Vercel, with a per-environment table).
3. Confirm your Vercel plan allows the analyze route's `maxDuration = 60`.

## Missing environment configuration

Nothing is configured for you. Required: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (or legacy `…_ANON_KEY`), `SUPABASE_SERVICE_ROLE_KEY`, and `NEXT_PUBLIC_SITE_URL` for Production only. Optional: `ANTHROPIC_API_KEY` (without it the demo works and AI shows a setup message), `ANTHROPIC_MODEL`, `AI_TIMEOUT_MS`. `.env.local` here holds your real Supabase keys: it is gitignored and was never printed or committed. **Rotate the Supabase service-role key**: it was once written into `.env.example` earlier in this project.

## Not verified

- **No real Supabase project**: migrations there, PostgREST/GoTrue transport, cookie sessions, confirmation and reset emails, redirect allow-list behaviour. The emulator reproduces the schema, RLS, grants and the HTTP shapes the app uses, not the service.
- **No real Anthropic call**: output quality, latency, real token counts, schema adherence. Tests use a mocked provider; the local stack uses a deterministic stub that is not a model.
- **No Vercel build or runtime**; function duration vs your plan; Deployment Protection effects on previews.
- `npm run test:rls` (live) not run. Screenshots in the README are from the local emulator stack on the simulated demo data, not from a deployment.
- Not visually reviewed: `global-error.tsx` (no way to trigger it safely), the 1024 px layout of signed-in pages (checked 1440 and 390 only), dark theme only (there is no light theme).

## Known limitations

- Analysis content can be forged by its **own owner** via a direct `finish_analysis` call (verification is app-side). Fix: final service-role write after verification.
- No CSP `script-src`; no per-user limits on project/key creation, test events or the demo seeder; `x-forwarded-for` trusted for the failed-auth throttle (safe on Vercel); no data retention; incident search is `ILIKE '%…%'`; the active-key cap can be exceeded slightly under concurrency; single-user projects (no teams); not live (no polling or realtime).
- Unknown/malformed incident ids render the not-found page with HTTP 200 (the route streams behind a loading skeleton); harmless behind auth.
- Scaling bottlenecks (hot incident row, row-by-row ingest, three RPCs per request, unbounded `events`) are listed in INTERVIEW_GUIDE.md §9.

## Final release checklist

- [x] Lint, type-check, unit, integration, production build, SDK build: all pass
- [x] Signed-out e2e on a production build; signed-in e2e against the local emulator (69/69)
- [x] Critical flow (event → events list → incident → AI → evidence → resolve → persists) automated in a browser and without one
- [x] Failure cases covered (bad/oversized payloads, duplicates, revoked keys, DB failure, other users, missing AI config, provider timeout, malformed AI output, fabricated citations, double-click)
- [x] No secrets in tracked files; `.env.local` ignored; `.env.example` placeholders only; generated junk removed
- [x] README (screenshots, architecture, env reference, migrations, API, AI design, testing, deployment, trade-offs) and INTERVIEW_GUIDE.md written
- [ ] Apply 7 migrations on Supabase and pass `verify.sql`
- [ ] Set Supabase redirect URLs and Vercel env vars (Production + Preview); deploy; check `/api/health`
- [ ] Run `npm run test:rls` and the signed-in e2e (`critical-flow`, `demo-walkthrough`) against the deployment (throwaway account)
- [ ] Run one real AI investigation; check `analyses.usage` and the answer
- [ ] Rotate the Supabase service-role key
