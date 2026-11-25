/**
 * kb/publication.added -> backfill-publication.
 *
 * It takes EVERY entry in the feed, skips the articles already stored, and fans out
 * `kb/article.discovered` with `via="backfill"` in batches.
 *
 * The fan-out is cheap on purpose: the expensive work happens in
 * `ingest-article`, where concurrency, throttling and priority decide when each
 * article actually runs.
 */

import { NonRetriableError } from "inngest";
import { settings } from "../config";
import { createJob, getExistingCanonicalIds, upsertPublication } from "../db/queries";
import { getDb, withTransaction } from "../db/session";
import { client } from "../inngest-client";
import {
  ARTICLE_DISCOVERED,
  ArticleDiscovered,
  PUBLICATION_ADDED,
  PublicationAdded,
} from "../schemas/events";
import { canonicalId } from "../schemas/ids";
import { findPublicationForUrl, loadPublications, PublicationEntry } from "../sources/allowlist";
import { fetchFeed, parseFeed } from "../sources/rss";

/** The allowlisted publication for `feedUrl`; a feed outside the allowlist is never retried. */
export function matchAllowlist(feedUrl: string): PublicationEntry {
  const pub = findPublicationForUrl(feedUrl, loadPublications());
  if (pub == null) {
    throw new NonRetriableError(`Feed is outside the allowlist (publications.yaml): '${feedUrl}'`);
  }
  return pub;
}

/** Upsert the publication row and return its id. */
export function savePublication(pub: PublicationEntry): Promise<string> {
  return withTransaction((db) =>
    upsertPublication(db, {
      slug: pub.slug,
      name: pub.name,
      feedUrl: pub.feed_url,
      homepage: pub.homepage,
    }),
  );
}

/** Every feed entry as an `ArticleDiscovered` payload, minus the ones already stored. */
async function findNewArticles(
  pub: PublicationEntry,
  publicationId: string,
  feedText: string,
): Promise<ArticleDiscovered[]> {
  const candidates = (await parseFeed(feedText)).map((entry) =>
    ArticleDiscovered.parse({
      canonical_id: canonicalId(pub.slug, entry.url),
      publication_id: publicationId,
      url: entry.url,
      title: entry.title,
      published_at: entry.published_at,
      via: "backfill",
    }),
  );
  if (candidates.length === 0) return [];
  const stored = await getExistingCanonicalIds(
    getDb(),
    candidates.map((c) => c.canonical_id),
  );
  return candidates.filter((c) => !stored.has(c.canonical_id));
}

async function recordAndFanOut(
  eventId: string,
  publicationId: string,
  newArticles: Record<string, unknown>[],
): Promise<{ discovered: number }> {
  // The job row goes first: GET /jobs counts articles written after the job
  // started, so it must exist before the first article can land.
  await withTransaction((db) =>
    createJob(db, { eventId, kind: "backfill", total: newArticles.length, publicationId }),
  );

  const batchSize = settings.backfillBatchSize;
  for (let start = 0; start < newArticles.length; start += batchSize) {
    const batch = newArticles.slice(start, start + batchSize);
    await client.send(batch.map((data) => ({ name: ARTICLE_DISCOVERED, data })));
  }
  return { discovered: newArticles.length };
}

export const backfillPublication = client.createFunction(
  {
    id: "backfill-publication",
    triggers: [{ event: PUBLICATION_ADDED }],
    retries: 3,
  },
  async ({ event, step }) => {
    const payload = PublicationAdded.parse(event.data);
    const eventId = event.id;
    if (!eventId) throw new Error("backfill-publication: triggering event has no id");

    const matched = await step.run("match-allowlist", () => matchAllowlist(payload.feed_url));
    const pub = PublicationEntry.parse(matched);
    const feedText = await step.run("fetch-feed", () => fetchFeed(pub.feed_url));
    const publicationId = await step.run("upsert-publication", () => savePublication(pub));
    const newArticles = await step.run("find-new-articles", () =>
      findNewArticles(pub, publicationId, feedText),
    );
    return step.run("record-and-fan-out", () =>
      recordAndFanOut(eventId, publicationId, newArticles),
    );
  },
);
