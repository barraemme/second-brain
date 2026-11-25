/**
 * kb/publication.added -> discovery.
 *
 * Fetches the feed, upserts the publication, takes the most recent
 * `discoveryLimit` entries, and fans out
 * `kb/article.discovered` with `via="rss"` for every entry that isn't stored yet.
 * Re-adding a publication therefore retries exactly the articles whose
 * `ingest-article` run failed, and skips the ones that already succeeded.
 *
 * Not registered in `kb/functions/index.ts`: `backfill-publication`
 * (`backfill.ts`) listens to the same event and handles the whole feed. This
 * simpler version stays because the first guide in `docs/` walks through it.
 */

import { settings } from "../config";
import { createJob, getExistingCanonicalIds } from "../db/queries";
import { getDb, withTransaction } from "../db/session";
import { client } from "../inngest-client";
import {
  ARTICLE_DISCOVERED,
  ArticleDiscovered,
  PUBLICATION_ADDED,
  PublicationAdded,
} from "../schemas/events";
import { canonicalId } from "../schemas/ids";
import { PublicationEntry } from "../sources/allowlist";
import { fetchFeed, parseFeed } from "../sources/rss";
import { matchAllowlist, savePublication } from "./backfill";

async function discoverAndSendEvents(
  eventId: string,
  pub: PublicationEntry,
  publicationId: string,
  feedText: string,
): Promise<{ count: number; emitted: number }> {
  const entries = (await parseFeed(feedText)).slice(0, settings.discoveryLimit);
  const discovered = entries.map((entry) =>
    ArticleDiscovered.parse({
      canonical_id: canonicalId(pub.slug, entry.url),
      publication_id: publicationId,
      url: entry.url,
      title: entry.title,
      published_at: entry.published_at,
      via: "rss",
    }),
  );
  const stored = await getExistingCanonicalIds(
    getDb(),
    discovered.map((d) => d.canonical_id),
  );
  const missing = discovered.filter((d) => !stored.has(d.canonical_id));
  if (missing.length > 0) {
    // One batched send, not one call per article.
    await client.send(missing.map((data) => ({ name: ARTICLE_DISCOVERED, data })));
  }
  await withTransaction((db) =>
    createJob(db, { eventId, kind: "discovery", total: discovered.length, publicationId }),
  );
  return { count: discovered.length, emitted: missing.length };
}

export const addPublication = client.createFunction(
  {
    id: "add-publication",
    triggers: [{ event: PUBLICATION_ADDED }],
    retries: 3,
  },
  async ({ event, step }) => {
    const payload = PublicationAdded.parse(event.data);
    const eventId = event.id;
    if (!eventId) throw new Error("add-publication: triggering event has no id");

    const matched = await step.run("match-allowlist", () => matchAllowlist(payload.feed_url));
    const pub = PublicationEntry.parse(matched);
    const feedText = await step.run("fetch-feed", () => fetchFeed(pub.feed_url));
    const publicationId = await step.run("upsert-publication", () => savePublication(pub));
    return step.run("discover-and-emit", () =>
      discoverAndSendEvents(eventId, pub, publicationId, feedText),
    );
  },
);
