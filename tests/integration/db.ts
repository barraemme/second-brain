/**
 * Shared helpers for integration tests.
 *
 * Real Postgres ("never mock the database"), wrapped in one outer transaction
 * per test that is always rolled back. `useDbForTests` routes every
 * `getDb()` / `withTransaction()` call in the pipeline code to that same
 * transaction, so tests never leave residue and can be re-run against the
 * same dev database indefinitely.
 *
 * Integration tests need the stack from `make start`. When Postgres is not
 * reachable they are skipped: `describe.skipIf(!POSTGRES_AVAILABLE)(...)`.
 */

import { afterEach, beforeEach } from "bun:test";
import { type ControlledTransaction, type Kysely, sql } from "kysely";
import { createDb, useDbForTests } from "../../kb/db/session";
import type { DB } from "../../kb/db/types";

const PROBE_TIMEOUT_MS = 2_000;

async function probePostgres(db: Kysely<DB>): Promise<boolean> {
  const timeout = new Promise<boolean>((resolve) => setTimeout(resolve, PROBE_TIMEOUT_MS, false));
  const probe = sql`SELECT 1`
    .execute(db)
    .then(() => true)
    .catch((error: unknown) => {
      console.warn(`integration tests skipped: Postgres is not reachable (${String(error)})`);
      return false;
    });
  return Promise.race([probe, timeout]);
}

const testDb = createDb();
export const POSTGRES_AVAILABLE = await probePostgres(testDb);

/**
 * Register beforeEach/afterEach hooks that open an outer transaction and roll
 * it back. Call inside a `describe` block. Returns a getter for the current
 * transaction, for tests that query the database directly.
 */
export function useRollbackDb(): () => Kysely<DB> {
  let trx: ControlledTransaction<DB> | undefined;
  beforeEach(async () => {
    trx = await testDb.startTransaction().execute();
    useDbForTests(trx);
  });
  afterEach(async () => {
    useDbForTests(undefined);
    await trx?.rollback().execute();
    trx = undefined;
  });
  return () => {
    if (trx === undefined) throw new Error("useRollbackDb: no transaction outside a test");
    return trx;
  };
}
