/**
 * The demo scenario, described once. The SQL seeder (`seed_demo_project`) implements exactly this
 * story; integration tests assert the database matches these numbers, so the two cannot drift apart.
 *
 * Everything is relative to the demo clock A (the moment the demo is created), in UTC:
 *
 *   A-7d ... A       steady normal traffic, one request log every 10 minutes (runs through the whole story)
 *   A-150m           deployment 2.14.0 ("reserve inventory in parallel")
 *   A-145m ... A-100m  60 HTTP 500s + 24 database timeouts on POST /api/checkout  -> ONE incident
 *   A-99m            rollback to 2.13.2; errors stop; the rest is recovery
 *
 * Baseline request logs are info-level and intentionally not grouped into incidents.
 */
export const DEMO = {
  projectName: "Demo (simulated storefront)",
  /** Model name stored on the pre-written analysis; the UI labels anything with it as simulated. */
  analysisModel: "demo-fixture",
  endpoint: "POST /api/checkout",
  minutesAgo: { deployBad: 150, burstStart: 145, burstEnd: 100, rollback: 99, analysis: 90 },
  counts: {
    traffic: 1008,
    http500: 60,
    dbTimeouts: 24,
    incidentEvents: 84,
    deployments: 2,
  },
  versions: { bad: "2.14.0", good: "2.13.2" },
} as const;

export const DEMO_TOTAL_EVENTS = DEMO.counts.traffic + DEMO.counts.incidentEvents;
