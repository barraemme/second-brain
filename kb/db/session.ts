/**
 * The Kysely instance, plus the one helper every writer uses: `withTransaction`.
 *
 * Python's `async with get_session() as s: ...; await s.commit()` becomes
 * `await withTransaction((db) => ...)`: it commits when the callback resolves
 * and rolls back when it throws. Plain reads use `getDb()` directly. A
 * transaction is never held across an Inngest step boundary.
 */

import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { settings } from "../config";
import type { DB } from "./types";

const PG_INT8_OID = 20;
const PG_NUMERIC_OID = 1700;

// COUNT(*) is int8 and NUMERIC is arbitrary precision; node-postgres returns
// both as strings. Every value here fits a JS number, so parse once, globally.
pg.types.setTypeParser(PG_INT8_OID, (value) => Number.parseInt(value, 10));
pg.types.setTypeParser(PG_NUMERIC_OID, (value) => Number.parseFloat(value));

/** `postgresql+asyncpg://` (the Python driver prefix in older `.env` files) -> `postgresql://`. */
export function toPgUrl(url: string): string {
  return url.replace(/^postgresql\+\w+:\/\//, "postgresql://");
}

/** Build a new Kysely instance with its own pool. The caller owns `destroy()`. */
export function createDb(databaseUrl: string = settings.databaseUrl): Kysely<DB> {
  const pool = new pg.Pool({ connectionString: toPgUrl(databaseUrl) });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

// The process-wide pool, created on first use so importing this module never
// connects. `useDbForTests` swaps it for an outer transaction that a test
// rolls back, so integration tests leave no rows behind.
let sharedDb: Kysely<DB> | undefined;
let testDb: Kysely<DB> | undefined;

export function getDb(): Kysely<DB> {
  if (testDb !== undefined) return testDb;
  sharedDb ??= createDb();
  return sharedDb;
}

/** Test hook: route every `getDb()` / `withTransaction()` call to `db` (or back, with undefined). */
export function useDbForTests(db: Kysely<DB> | undefined): void {
  testDb = db;
}

/** Run `fn` in one transaction: commit on success, roll back on error. */
export async function withTransaction<T>(fn: (db: Kysely<DB>) => Promise<T>): Promise<T> {
  const db = getDb();
  // Inside a test's outer transaction there is nothing to open: Kysely does
  // not nest transactions, and the test rolls everything back at the end.
  if (db.isTransaction) return fn(db);
  return db.transaction().execute(fn);
}

/** Close the shared pool (scripts and graceful shutdown). */
export async function closeDb(): Promise<void> {
  if (sharedDb === undefined) return;
  await sharedDb.destroy();
  sharedDb = undefined;
}

/** JS value -> JSON text for a JSONB column (see `kb/db/types.ts`). */
export function toJson(value: unknown): string {
  return JSON.stringify(value);
}

/** Embedding -> pgvector text literal `[0.1,0.2,...]`. */
export function toVector(values: readonly number[]): string {
  if (values.length === 0) throw new Error("toVector: empty embedding");
  return `[${values.join(",")}]`;
}
