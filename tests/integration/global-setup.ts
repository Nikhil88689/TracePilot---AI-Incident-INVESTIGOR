import { startDatabase, type TestDatabase } from "./pg-harness";

let db: TestDatabase | undefined;

/** One real Postgres for the whole run; every migration is applied once. Port is shared via env. */
export async function setup() {
  db = await startDatabase();
  process.env.TP_TEST_PG_PORT = String(db.port);
}

export async function teardown() {
  await db?.stop();
}
