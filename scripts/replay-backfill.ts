/**
 * Replay a backfill and prove it writes nothing new.
 *
 *     bun scripts/replay-backfill.ts --verify            # print the counts
 *     bun scripts/replay-backfill.ts --all               # replay every publication
 *     bun scripts/replay-backfill.ts --slug decoding-ai  # replay one publication
 *
 * `--all` / `--slug` re-send `kb/publication.added` for publications in
 * `publications.yaml`, exactly like `POST /publications` does. Run `--verify`
 * before and after (once Inngest has finished): if ingestion is idempotent, the
 * publication, article and passage counts are identical, and so is the number
 * of embedding calls recorded in `costs`, because already-stored articles never
 * reach the `embed` step.
 */

import { parseArgs } from "node:util";
import type { Kysely } from "kysely";
import { settings } from "../kb/config";
import { closeDb, getDb } from "../kb/db/session";
import type { DB } from "../kb/db/types";
import { client } from "../kb/inngest-client";
import { PUBLICATION_ADDED, PublicationAdded } from "../kb/schemas/events";
import { loadPublications } from "../kb/sources/allowlist";

const USAGE = "usage: bun scripts/replay-backfill.ts (--verify | --all | --slug SLUG)";

async function countRows(
  db: Kysely<DB>,
  table: "publications" | "articles" | "passages",
): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

async function countEmbeddingCalls(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom("costs")
    .where("model", "=", settings.embeddingModel)
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

async function readCounts(): Promise<Record<string, number>> {
  const db = getDb();
  return {
    publications: await countRows(db, "publications"),
    articles: await countRows(db, "articles"),
    passages: await countRows(db, "passages"),
    embedding_calls: await countEmbeddingCalls(db),
  };
}

async function printCounts(): Promise<void> {
  const counts = await readCounts();
  console.info(
    Object.entries(counts)
      .map(([name, value]) => `${name}=${value}`)
      .join("  "),
  );
}

async function sendReplayEvents(slug: string | undefined): Promise<void> {
  let pubs = loadPublications();
  if (slug) {
    pubs = pubs.filter((p) => p.slug === slug);
    if (pubs.length === 0)
      throw new Error(`No publication with slug '${slug}' in publications.yaml`);
  }

  await printCounts();
  for (const pub of pubs) {
    await client.send({
      name: PUBLICATION_ADDED,
      data: PublicationAdded.parse({ feed_url: pub.feed_url, name: pub.name }),
    });
    console.info(`sent ${PUBLICATION_ADDED} for ${pub.slug}`);
  }
  console.info("Wait for the runs to finish in the Inngest UI, then run with --verify.");
}

/** Parse the CLI flags; exactly one of --verify / --all / --slug is required. */
function parseCli(): { verify: boolean; slug: string | undefined } {
  const { values } = parseArgs({
    options: {
      verify: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      slug: { type: "string" },
    },
  });
  const chosen = [values.verify, values.all, values.slug !== undefined].filter(Boolean).length;
  if (chosen !== 1) throw new Error(`exactly one of --verify, --all, --slug is required\n${USAGE}`);
  return { verify: values.verify, slug: values.slug };
}

async function main(): Promise<void> {
  const args = parseCli();
  try {
    await (args.verify ? printCounts() : sendReplayEvents(args.slug));
  } finally {
    await closeDb();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
