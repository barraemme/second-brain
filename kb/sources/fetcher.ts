/**
 * Article HTML fetch: robots.txt (cached per origin), User-Agent, timeout, max size.
 *
 * RSS entries may carry full content or only a summary: always fetch the
 * canonical URL here rather than trusting feed content.
 */

import robotsParser from "robots-parser";
import { settings } from "../config";
import { assertPublicUrl } from "./url-guard";

type Robot = ReturnType<typeof robotsParser>;

/** Parsed robots.txt per origin (`https://host:port`). Exported so tests can clear it. */
export const robotsCache = new Map<string, Robot>();

/** robots.txt disallow, too many redirects, or an oversized body: not retriable by re-fetching. */
export class FetchError extends Error {
  override name = "FetchError";
}

export interface FetchedPage {
  url: string;
  html: string;
  status_code: number;
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

function requestInit(): RequestInit {
  return {
    headers: { "User-Agent": settings.userAgent },
    redirect: "manual",
    signal: AbortSignal.timeout(settings.requestTimeoutS * 1000),
  };
}

function assertOk(response: Response, url: string): void {
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${JSON.stringify(url)}`);
}

/** Fetch (network) and cache robots.txt for the origin of `url`. */
async function fetchRobotParser(url: URL): Promise<Robot> {
  const cached = robotsCache.get(url.origin);
  if (cached !== undefined) return cached;

  const robotsUrl = `${url.origin}/robots.txt`;
  const response = await fetch(robotsUrl, requestInit());
  let body = "";
  if (response.status === 404) {
    await response.body?.cancel(); // no robots.txt at all -> nothing is disallowed
  } else {
    assertOk(response, robotsUrl);
    body = await response.text();
  }
  const parser = robotsParser(robotsUrl, body);
  robotsCache.set(url.origin, parser);
  return parser;
}

/**
 * GET `url` and follow redirects by hand, so the URL guard checks every hop.
 *
 * Returns the final response (body unread: the caller must consume or cancel it) and its URL.
 */
async function fetchFollowingPublicRedirects(
  url: string,
): Promise<{ response: Response; finalUrl: string }> {
  let current = url;
  for (let hop = 0; hop <= settings.maxRedirects; hop++) {
    await assertPublicUrl(current);
    const response = await fetch(current, requestInit());
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || location === null) {
      return { response, finalUrl: current };
    }
    await response.body?.cancel();
    current = new URL(location, current).href;
  }
  throw new FetchError(`More than ${settings.maxRedirects} redirects for ${JSON.stringify(url)}`);
}

/** Read the body as UTF-8, aborting as soon as it exceeds `maxArticleBytes`. */
async function readCappedBody(response: Response, url: string): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Every non-empty read adds at least one byte, so the byte cap also caps the reads.
  for (let reads = 0; reads <= settings.maxArticleBytes; reads++) {
    const { done, value } = await reader.read();
    if (done) return new TextDecoder().decode(Buffer.concat(chunks));
    total += value.byteLength;
    if (total > settings.maxArticleBytes) {
      await reader.cancel();
      throw new FetchError(
        `Article exceeds max_article_bytes (${settings.maxArticleBytes}): ${JSON.stringify(url)}`,
      );
    }
    chunks.push(value);
  }
  await reader.cancel();
  throw new FetchError(`Too many empty reads from the body of ${JSON.stringify(url)}`);
}

/** Fetch an article page. Throws `UnsafeUrlError` for any non-public hop, before any request. */
export async function fetchArticle(url: string): Promise<FetchedPage> {
  await assertPublicUrl(url);
  const robots = await fetchRobotParser(new URL(url));
  if (robots.isAllowed(url, settings.userAgent) !== true) {
    throw new FetchError(`robots.txt disallows fetching ${JSON.stringify(url)}`);
  }

  const { response, finalUrl } = await fetchFollowingPublicRedirects(url);
  if (!response.ok) await response.body?.cancel();
  assertOk(response, finalUrl);
  const html = await readCappedBody(response, finalUrl);
  return { url: finalUrl, html, status_code: response.status };
}
