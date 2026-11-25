/** RSS is an open standard. `rss-parser` reads both RSS 2.0 and Atom. */

import Parser from "rss-parser";
import { z } from "zod";
import { settings } from "../config";

export const FeedEntry = z.object({
  title: z.string(),
  url: z.string(),
  published_at: z.coerce.date(),
});
export type FeedEntry = z.infer<typeof FeedEntry>;

/** `[status_code, body_or_null, etag, last_modified]`. */
export type ConditionalFeed = [number, string | null, string | null, string | null];

function feedInit(headers: Record<string, string>): RequestInit {
  return {
    headers: { "User-Agent": settings.userAgent, ...headers },
    redirect: "follow",
    signal: AbortSignal.timeout(settings.requestTimeoutS * 1000),
  };
}

function assertOk(response: Response, feedUrl: string): void {
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching feed ${feedUrl}`);
}

/** GET the feed (network) and return its body, decoded as UTF-8. */
export async function fetchFeed(feedUrl: string): Promise<string> {
  const response = await fetch(feedUrl, feedInit({}));
  assertOk(response, feedUrl);
  return response.text();
}

/**
 * Fetch an RSS feed conditionally using ETag and Last-Modified headers.
 * Returns `[status_code, content_or_null, response_etag, response_last_modified]`.
 */
export async function fetchFeedConditional(
  feedUrl: string,
  etag: string | null = null,
  lastModified: string | null = null,
): Promise<ConditionalFeed> {
  const headers: Record<string, string> = {};
  if (etag) headers["If-None-Match"] = etag;
  if (lastModified) headers["If-Modified-Since"] = lastModified;

  const response = await fetch(feedUrl, feedInit(headers));
  const respEtag = response.headers.get("ETag") || etag;
  const respLastModified = response.headers.get("Last-Modified") || lastModified;

  if (response.status === 304) {
    await response.body?.cancel();
    return [304, null, respEtag, respLastModified];
  }
  assertOk(response, feedUrl);
  return [response.status, await response.text(), respEtag, respLastModified];
}

/** First parseable date among the entry's published/updated fields, or null. */
function entryDate(item: Parser.Item & Record<string, unknown>): Date | null {
  // rss-parser maps pubDate/published/updated into isoDate; `updated` covers Atom-only entries.
  for (const raw of [item.isoDate, item.pubDate, item.updated]) {
    if (typeof raw !== "string" || !raw) continue;
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

/** Parse a feed body into entries. Throws clearly if the feed does not parse at all. */
export async function parseFeed(raw: string): Promise<FeedEntry[]> {
  let feed: Parser.Output<Record<string, unknown>>;
  try {
    feed = await new Parser().parseString(raw);
  } catch (error) {
    throw new Error(`Feed did not parse: ${error instanceof Error ? error.message : error}`);
  }

  const entries: FeedEntry[] = [];
  for (const item of feed.items) {
    const publishedAt = entryDate(item);
    // Skip entries too malformed to use, don't fail the whole feed.
    if (!item.link || !item.title || publishedAt === null) continue;
    entries.push({ title: item.title, url: item.link, published_at: publishedAt });
  }
  return entries;
}
