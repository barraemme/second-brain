/**
 * Freshness: conditional polling cron.
 *
 * Runs every 5 minutes. Sends If-None-Match / If-Modified-Since headers to
 * each active publication origin.
 * - 304 (Not Modified): Zero downstream work. Increment not_modified_count.
 * - 200 (Modified): Parse entries, filter out known canonical IDs, and emit
 *   `kb/article.discovered` only for genuinely new content.
 */

import {
  getCursor,
  getExistingCanonicalIds,
  getPublicationBySlug,
  updateCursor,
  upsertPublication,
} from "../db/queries";
import { getDb, withTransaction } from "../db/session";
import { client } from "../inngest-client";
import { ARTICLE_DISCOVERED, ArticleDiscovered } from "../schemas/events";
import { canonicalId } from "../schemas/ids";
import { loadPublications, type PublicationEntry } from "../sources/allowlist";
import { fetchFeedConditional, parseFeed } from "../sources/rss";

interface PollResult {
  slug: string;
  status: number;
  new_articles: number;
}

/** The publication's id (upserting it on first sight) and its stored conditional-GET cursor. */
async function loadPublicationCursor(
  meta: PublicationEntry,
): Promise<{ pubId: string; etag: string | null; lastModified: string | null }> {
  return withTransaction(async (db) => {
    const pub = await getPublicationBySlug(db, meta.slug);
    const pubId =
      pub?.id ??
      (await upsertPublication(db, {
        slug: meta.slug,
        name: meta.name,
        feedUrl: meta.feed_url,
        homepage: meta.homepage,
      }));
    const cursor = await getCursor(db, pubId);
    return { pubId, etag: cursor?.etag ?? null, lastModified: cursor?.last_modified ?? null };
  });
}

/** Emit `kb/article.discovered` for every feed entry not stored yet; returns how many. */
async function sendNewArticleEvents(slug: string, pubId: string, raw: string): Promise<number> {
  const entries = await parseFeed(raw);
  if (entries.length === 0) return 0;

  const entryMap = new Map(entries.map((e) => [canonicalId(slug, e.url), e]));
  const existingIds = await getExistingCanonicalIds(getDb(), [...entryMap.keys()]);
  const events = [...entryMap]
    .filter(([cid]) => !existingIds.has(cid))
    .map(([cid, entry]) => ({
      name: ARTICLE_DISCOVERED,
      data: ArticleDiscovered.parse({
        canonical_id: cid,
        publication_id: pubId,
        url: entry.url,
        title: entry.title,
        published_at: entry.published_at,
        via: "poll",
      }),
    }));

  if (events.length > 0) await client.send(events);
  return events.length;
}

async function pollOne(meta: PublicationEntry): Promise<PollResult> {
  const slug = meta.slug;
  const { pubId, etag, lastModified } = await loadPublicationCursor(meta);

  const [statusCode, raw, respEtag, respLastModified] = await fetchFeedConditional(
    meta.feed_url,
    etag,
    lastModified,
  );

  const notModified = statusCode === 304 || raw == null;
  await withTransaction((db) =>
    updateCursor(db, {
      publicationId: pubId,
      etag: respEtag,
      lastModified: respLastModified,
      notModified,
    }),
  );
  if (notModified || raw == null) return { slug, status: 304, new_articles: 0 };

  // Status 200: Parse and check for new content
  const newArticles = await sendNewArticleEvents(slug, pubId, raw);
  return { slug, status: 200, new_articles: newArticles };
}

export const pollFeeds = client.createFunction(
  {
    id: "poll-feeds",
    name: "Poll Feeds for Freshness",
    triggers: [{ cron: "*/5 * * * *" }, { event: "kb/feed.poll" }],
  },
  /** Poll active publication feeds conditionally. */
  async ({ step }) => {
    const pubs = loadPublications();
    const results: PollResult[] = [];
    // Bounded by the allowlist: one step per publication in publications.yaml.
    for (const pubMeta of pubs) {
      results.push(await step.run(`poll-${pubMeta.slug}`, () => pollOne(pubMeta)));
    }
    return { polled_count: results.length, results };
  },
);
