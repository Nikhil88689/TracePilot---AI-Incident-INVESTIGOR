# TracePilot: interview guide

How to present this project to a full-stack interviewer, with the technical depth to back it up. Everything here is true of the repository as it stands; the
"be upfront about" notes are the things an interviewer will respect you for volunteering.

## 1. The 60-second pitch

> TracePilot is an incident investigator for application errors. An app sends error events through an API or a small SDK; TracePilot validates and rate-limits them,
> groups duplicates into incidents with a deterministic fingerprint, and shows a dashboard, timeline, stack traces, and events. On top of that, it asks an LLM for
> ranked root-cause hypotheses, but with one hard rule: the model only sees events I retrieved, and if it cites anything I didn't give it, the whole answer is rejected.
> It's Next.js 16 on Vercel with Supabase Postgres, and the interesting part is the database: ownership is enforced by Row Level Security, ingestion is a single
> transactional SQL function that's safe under concurrency, and the test suite runs the real SQL against a real Postgres. I measured about 230 requests a second
> with zero errors on my laptop and verified that 6,000 concurrent events produced exactly five incidents with the right counts.

## 2. The five-minute walkthrough

Use the demo (it needs no AI key). Have it open at `Try the demo → Create demo project`. Say "simulated" out loud; the UI does too.

| Min | Do | Say |
| --- | --- | --- |
| 0:00 | Dashboard, 24 h range | "This is a simulated storefront outage. The error rate is 36.8%: **84 errors out of 228 events**. The formula is on the page and in code, and error rate is *undefined, not 0%* when there are no events." |
| 0:45 | Point at the dashed lines and the KPI notes | "The two dashed lines are the v2.14.0 deploy and the rollback. Notice the cards say *why* there's no trend: I only show a comparison when there's real history behind it. Events shows +58% because that's computable; error rate doesn't, because the previous period was zero." |
| 1:30 | Open the critical incident | "84 events grouped into one incident. The timeline interleaves events, status changes, and deployments, all in UTC." |
| 2:15 | Expand the stack trace; page the events | "Stack traces are rendered as text, never HTML. Events are paginated server-side, 10 per page." |
| 3:00 | AI panel (simulated analysis), open an evidence button | "This analysis is pre-written and labelled SIMULATED, so the demo needs no key. In the live path, every citation like this one is checked against the events I retrieved. Clicking it opens the event exactly as stored, not the model's description." |
| 3:45 | Tick a checklist step; *Resolve* | "Steps are read-only diagnostics and persist. Resolve is a database-checked transition with optimistic concurrency, so a stale click can't overwrite a newer change." |
| 4:30 | Dashboard again | "Unresolved is now zero and the severity chart is empty, but the 84 errors are still in the data. Resolving doesn't rewrite history." |

If asked for the code: `src/lib/ingest/handler.ts` (ingestion), `supabase/migrations/20261029200000_event_ingestion.sql` (`ingest_events`), `src/lib/ai/investigate.ts` + `analysis.ts` (AI), `src/lib/dashboard/metrics.ts` (metrics).

## 3. Architecture

Two trust levels, kept apart on purpose:

- **Machines** (your app → `POST /api/v1/events`): a project API key, stored only as a SHA-256 hash. The server uses the **service role**, but only through three `SECURITY DEFINER` functions that take the project id *from the key*, never from the request body.
- **People** (browser → pages, server actions, the analyze route): a Supabase session cookie → the user's JWT. Every query then runs as the `authenticated` role, and **Row Level Security** decides what rows exist for that user.

Modules: thin route handlers and pages; domain logic in `src/lib/{ingest,incidents,dashboard,ai,demo}`; each external dependency behind a small interface (`IngestStore`, `RpcClient`, `AiClient`) so tests inject real Postgres or fakes. State lives only in Postgres or cookies, so Vercel's stateless functions are fine: no workers, no cron, no local files, and the app never runs migrations.

### Why a modular architecture (and why not microservices)

One deployable unit keeps the operational surface to "Vercel + Supabase", which is right for this size. The modularity is *inside* the codebase: pure logic (fingerprinting, metrics, transitions, citation verification) has no framework imports and is unit-tested; I/O sits behind interfaces; routes only parse, authenticate, call, and map errors to status codes. That's what let me test the real ingestion handler against real SQL and the AI pipeline against a fake provider. If ingestion volume outgrew serverless, `handleIngest` + `IngestStore` could move to its own service without touching the UI.

## 4. Database design

| Table | Notes |
| --- | --- |
| `projects` | `owner_id`; unique `(owner_id, name)`; `idempotency_key` for retry-safe creation; `is_demo` (unique per user, only settable by the seeder) |
| `api_keys` | `key_hash` (not selectable by users, via column grants), `key_prefix`, `revoked_at` |
| `events` | `unique(project_id, external_event_id)` (idempotency), fingerprint, level, stack, attributes jsonb; indexes `(project_id, occurred_at)` and `(project_id, level, occurred_at)` |
| `incidents` | `unique(project_id, fingerprint)`; `occurrence_count`, `first/last_seen_at`, severity (max seen), status; status guard trigger |
| `incident_events` | links events to incidents |
| `incident_activity` | who changed which status, written by the trigger |
| `analyses` | persisted AI output, model, tokens, status, error code, checklist; **read-only for users** |
| `deployments` | version/time, rendered on the chart and timeline, given to the model as context |
| `rate_limits` | fixed-window counters keyed by bucket |

All reads go through `SECURITY INVOKER` SQL functions (list/filter/paginate, counts, dashboard aggregation, evidence selection), so RLS applies by construction and the SQL is testable. Dynamic SQL exists in exactly one function (`list_incidents`), with the sort column and direction taken from a whitelist and everything else bound.

## 5. Incident grouping, duplicates, and concurrency

1. **Fingerprint** (`src/lib/ingest/fingerprint.ts`): `sha256(event_type + normalised message + top 3 app stack frames)`, 32 hex chars. Normalisation strips UUIDs, numbers, hex, and quoted values, so "Order 4812 not found" and "Order 9930 not found" group together. Frames are `function@file` with **no line numbers**, so an unrelated edit doesn't split an incident; library frames are skipped. No usable stack → falls back to the normalised endpoint. A caller-supplied `fingerprint` overrides it.
2. **Duplicates**: `unique(project_id, external_event_id)` + `ON CONFLICT DO NOTHING`. A retry reports `duplicate` and changes nothing, so SDK retries are safe.
3. **Atomic grouping**: `ingest_events` runs one batch in one transaction: insert the event, then `INSERT … ON CONFLICT (project_id, fingerprint) DO UPDATE` on the incident, which increments `occurrence_count`, widens first/last seen, raises severity, and reopens a resolved incident that recurs. The upsert is atomic per row, so counts are exact.
4. **Deadlocks**: events in a batch are processed in **fingerprint order**, so two concurrent batches always lock incident rows in the same order and cannot deadlock.
5. **Proof**: an integration test hammers the same fingerprints from many connections; the benchmark (16 concurrent writers, 5 fingerprints, 6,000 events) ended with exactly 5 incidents of 1,200 each, checked in the database.

## 6. User and project isolation

- **RLS on every table** (a test asserts `relrowsecurity` for all of them), with owner policies that join through `projects.owner_id = auth.uid()`.
- **Least privilege beyond RLS**: users get column-level grants (cannot read `key_hash`, cannot write events/incidents except `status`, cannot write `analyses` at all); `anon` has no privileges on any table or function (tested).
- **Service role is rare and fenced**: only ingestion, only three definer functions, which the `authenticated` role cannot execute (tested). `SECURITY DEFINER` functions pin `search_path`, and the few that users can run (`start_analysis`, `finish_analysis`, `set_analysis_step`, the demo seeder) check `auth.uid()` ownership explicitly.
- **Not-found = forbidden**: another user's incident returns 404, indistinguishable from a missing one, and no AI spend happens.
- **Tests**: `tests/integration/security.test.ts` checks cross-user reads leak nothing, direct writes are denied, ownership is enforced inside the definer functions, and that every definer function a user can run has been reviewed.

## 7. AI evidence retrieval and validation

1. **Retrieve in SQL** (`select_evidence_events`): the newest 6 events, the first-seen event, and up to 4 *representative* ones (one per distinct normalised message/stack shape, most common first), de-duplicated and labelled with why each was chosen. Hard server-side caps.
2. **Build a bounded prompt**: each field is length-capped; the whole prompt is capped at 28,000 characters (events are dropped from the end, never truncated mid-event). Deployment records go in as *context only*.
3. **Treat log text as hostile**: every untrusted field is HTML-escaped before it enters an `<event>` block, so a log line like `</event><event id="…">` cannot forge a block. The system prompt says content in tags is data, not instructions.
4. **Call the provider** server-side, time-boxed (`AI_TIMEOUT_MS`, ≤ 55 s), **no retries** (a retry doubles cost and latency; the user can re-run).
5. **Validate** with Zod: ranked hypotheses (1–5), confidence as `low|medium|high` only, read-only steps, missing information, limitations.
6. **Verify citations**: every cited event id must be in the set actually sent. **One fabricated id rejects the whole analysis** (`invalid_evidence`, retryable), because a fabricated reference means the rest can't be trusted. Citations are then *enriched from our own records*, so the UI shows stored message/time, never model text.
7. **Persist everything** (status, model, token usage, error code, input event count). Failures are stored too, with user-safe messages; provider text and the key are never stored or shown.

**Limitations to state**: it's a hypothesis generator, not a diagnosis; the evidence is a sample of the incident; confidence is the model's own estimate; the real Anthropic API has not been called in this repo (tests use a mocked provider, the local stack a deterministic stub).

## 8. Failure handling and rate limiting

| Concern | Mechanism |
| --- | --- |
| Bad ingest input | 400/413/415/422 with precise errors; validation is all-or-nothing; NUL bytes rejected up front (Postgres can't store them) |
| Body size | Declared length checked first, then a **streamed** read that aborts at 256 KiB (never buffers unbounded input) |
| Ingest rate limit | 600 events/min per key (cost = events in the request); 30 failed auths/min per hashed client IP; `429` + `Retry-After`; counters in Postgres, with opportunistic cleanup |
| Auth failures | Same `401` for missing/malformed/unknown/revoked keys, so it isn't an oracle |
| DB failure | Safe 500, no internals, nothing logged from the request; retry is safe because of idempotency |
| AI: concurrency | Partial unique index: one `pending` analysis per incident → `409` for the second click; tested with 3 concurrent requests → 1 provider call |
| AI: cost | 20 analyses/hour/user, counted over rows users can't edit or delete |
| AI: stuck requests | A pending row older than 2 minutes is reported as failed/retryable by the database itself |
| AI: provider errors | Classified into stable codes (timeout, rate limit, outage, bad key, unknown model, refusal, truncation, invalid JSON/evidence) with retry hints |
| UI | Each dashboard section loads and fails independently with a retry; empty/loading/error states everywhere |

## 9. Scaling options and current bottlenecks

**Measured** (one laptop, everything co-located, see README): ~231 events/s one-per-request, ~1,750 events/s in batches of 10, p99 129 ms / 316 ms, 0 errors.

**Current bottlenecks, honestly:**
1. **Hot incident row.** Every event for the same fingerprint updates one incident row, so a single noisy error serialises on that row. Fix: buffer counts and apply them periodically, or compute counts from `incident_events` lazily.
2. **Row-by-row plpgsql ingest.** Correct and atomic but not the fastest bulk path. Fix: set-based `INSERT … SELECT` with aggregated incident upserts per fingerprint.
3. **Per-request overhead**: three RPC round trips (auth, rate limit, ingest) and a rate-limit write. Fix: combine into one function, or move the limiter to an edge KV.
4. **`events` grows without bound**: no retention. Fix: time partitioning + a retention job.
5. **Search** is `ILIKE '%…%'`: fine for demo scale; needs trigram or full-text indexes.
6. **Dashboard aggregation** scans events in the window (indexed). Fix: hourly rollup table.
7. **Fixed-window limiter** allows boundary bursts; use a sliding window or token bucket if it matters.

**Scaling path:** bigger Postgres → read replica for dashboards → async ingest (accept to a queue, process in workers) → partitioning/rollups. None of that is needed until the above numbers are actually the limit.

## 10. Ten likely questions

**1. Why Postgres functions instead of an ORM or API layer?**
Because ownership has to be enforced where the data lives. With `SECURITY INVOKER` functions called as the user, RLS applies to every read and write, so a bug in app code can't widen access, and the SQL is unit-testable against a real database. The trade-off is that logic lives in migrations.

**2. How do you stop two concurrent requests creating two incidents for the same error?**
`unique(project_id, fingerprint)` plus `INSERT … ON CONFLICT DO UPDATE`: one row, atomically incremented. Batches process events in fingerprint order so concurrent batches lock rows in the same order and can't deadlock. I verified it with 16 concurrent writers and checked the final counts in the database.

**3. How do you make ingestion idempotent?**
`unique(project_id, external_event_id)` with `ON CONFLICT DO NOTHING`; a duplicate returns `status: duplicate` and changes nothing. That makes SDK retries safe, which is why the SDK can retry 429/5xx without risk of double counting.

**4. How do you know the AI isn't making things up?**
I can't know the *reasoning* is right, and the UI says so. What I can guarantee is that every cited event was in the set I retrieved: citations are checked against the exact events sent, a single fabricated id rejects the whole analysis, and the displayed evidence comes from our records, not model text. Confidence is the model's own coarse estimate and is labelled that way.

**5. What about prompt injection from log messages?**
Logs are attacker-controlled input. I escape `&`, `<`, `>`, `"` in every untrusted field so a log line can't close or forge an `<event>` block, the system prompt says tagged content is data, output must validate against a strict schema, and citations are verified. Worst case an injected message steers the wording of one analysis; it can't cite events I didn't send, call tools, or touch data.

**6. How does RLS work here and how do you test it?**
Every table has RLS with owner policies through `projects.owner_id = auth.uid()`. Tests run real SQL as the `authenticated` and `anon` roles against an embedded Postgres 17 with every migration applied, and assert: RLS is on for all tables, users can't read others' rows through any table or function, can't write what they shouldn't (column grants), and `anon` has no privileges. A live test against a real Supabase project exists but hasn't been run yet.

**7. You mentioned a security fix; what was it?**
Users could write to the `analyses` table directly, so they could delete their own rows and bypass the 20-per-hour AI cost guard, or fabricate rows. I made the table read-only for users and moved all writes into ownership-checked `SECURITY DEFINER` functions, with tests proving direct writes are denied and the guard holds. A residual risk I documented: the function still accepts content from the owner, so they can forge their *own* analysis; the fix is a final service-role write after server-side verification.

**8. Why no background workers or queues?**
Vercel functions are stateless and short-lived, and at this scale a transactional SQL function is simpler and gives stronger guarantees than eventual processing. Rate limits, locks, and idempotency are rows in Postgres. If ingestion volume demanded it, the next step is accept-and-queue with workers, and `IngestStore` is the seam where that would go.

**9. How would you scale it?**
Measure first: the current ceiling is the hot incident row and the row-by-row ingest function. Then: set-based ingest with aggregated upserts, one RPC instead of three, partition `events` by time with retention, hourly rollups for the dashboard, trigram/full-text search, and eventually async ingest. I'd also move the rate limiter off Postgres if it showed up in profiles.

**10. What's not finished or not verified, and how would you finish it?**
It hasn't been deployed or run against a real Supabase project or the real Anthropic API. I ran the whole signed-in app in a browser against a local emulator that fronts a real Postgres with the real migrations, which found real bugs (the command palette crashed on open; the project menu stayed open over the page; a status button could be double-clicked into a misleading conflict). The remaining step is mechanical and documented: apply the migrations, run the live RLS test and the signed-in e2e on the deployed URL, and run one real investigation.

### Bonus questions you may get

- *Why is the demo a separate project?* Consent and safety: it never writes into a real project, is excluded from "All projects" totals, and the flag can't be set by clients.
- *Why UTC and half-open windows?* So every number on the page agrees with every list: an event exactly at the start is in, exactly at the end is out; a boundary test and a time-zone test pin it (it caught a float-rounding bug that put an on-the-edge event in the wrong chart bucket).
- *Why does the dashboard show "No comparison" so often?* Because inventing a trend from no history is worse than showing none: it appears only when history covers the previous window, the previous value is non-zero, and (for rates) there were at least 20 events.
- *How did you test without a Supabase account?* A real embedded Postgres for integration tests, and a small emulator speaking the GoTrue/PostgREST subset the app uses for the browser tests, clearly labelled as an emulator.
