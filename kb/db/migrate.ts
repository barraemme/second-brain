/**
 * Apply `migrations/*.sql` in file-name order, each in its own transaction,
 * and record each applied file in `schema_migrations`.
 *
 * A database migrated by the old Python/Alembic toolchain is adopted, not
 * rebuilt: if `alembic_version` is at the last Python revision, the baseline
 * file is recorded as applied without running it.
 *
 * Run: `bun run migrate`.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type Kysely, sql } from "kysely";
import { closeDb, getDb } from "./session";
import type { DB } from "./types";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const BASELINE = "0001_baseline.sql";
const ALEMBIC_HEAD = "b8d2e4f6a1c3";

async function ensureMigrationsTable(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`.execute(db);
}

async function readAppliedNames(db: Kysely<DB>): Promise<Set<string>> {
  const { rows } = await sql<{ name: string }>`SELECT name FROM schema_migrations`.execute(db);
  return new Set(rows.map((row) => row.name));
}

/** The Alembic revision of this database, or null when Alembic never ran here. */
async function readAlembicRevision(db: Kysely<DB>): Promise<string | null> {
  const { rows: tables } = await sql<{ present: boolean }>`
    SELECT to_regclass('public.alembic_version') IS NOT NULL AS present`.execute(db);
  if (!tables[0]?.present) return null;
  const { rows } = await sql<{ version_num: string }>`
    SELECT version_num FROM alembic_version`.execute(db);
  return rows[0]?.version_num ?? null;
}

/** Record the baseline as applied on a database that Alembic already brought to its head. */
async function adoptAlembicDatabase(db: Kysely<DB>, applied: Set<string>): Promise<void> {
  if (applied.has(BASELINE)) return;
  const revision = await readAlembicRevision(db);
  if (revision === null) return;
  if (revision !== ALEMBIC_HEAD) {
    throw new Error(
      `alembic_version is at ${revision}, not ${ALEMBIC_HEAD}. Upgrade this database with the ` +
        "last Python release (alembic upgrade head) before switching to the TypeScript migrations.",
    );
  }
  await sql`INSERT INTO schema_migrations (name) VALUES (${BASELINE})`.execute(db);
  applied.add(BASELINE);
  console.info(`migrate: adopted Alembic database at ${revision}, marked ${BASELINE} applied`);
}

async function applyMigrationFile(db: Kysely<DB>, name: string): Promise<void> {
  const body = await Bun.file(join(MIGRATIONS_DIR, name)).text();
  await db.transaction().execute(async (trx) => {
    await sql.raw(body).execute(trx);
    await sql`INSERT INTO schema_migrations (name) VALUES (${name})`.execute(trx);
  });
  console.info(`migrate: applied ${name}`);
}

/** Apply every pending migration. Returns the names applied by this call. */
export async function migrateDatabase(db: Kysely<DB>): Promise<string[]> {
  await ensureMigrationsTable(db);
  const applied = await readAppliedNames(db);
  await adoptAlembicDatabase(db, applied);

  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort();
  const pending = files.filter((name) => !applied.has(name));
  for (const name of pending) {
    await applyMigrationFile(db, name);
  }
  return pending;
}

if (import.meta.main) {
  try {
    const applied = await migrateDatabase(getDb());
    console.info(`migrate: ${applied.length} migration(s) applied, schema is up to date`);
  } finally {
    await closeDb();
  }
}
