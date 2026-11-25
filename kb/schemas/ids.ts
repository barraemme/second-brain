/**
 * ID helpers: the dedupe keys for the whole project.
 *
 * Pure functions, no I/O: they must be unit-testable without a database or
 * network, and every writer in the pipeline (RSS, backfill, freshness,
 * manual ingestion) calls through them instead of building ids ad hoc.
 */

import { randomBytes } from "node:crypto";

export const ARTICLE_CLAIM_NAMESPACE = "7b9e4c1a-3d2f-4e8b-9a1c-5f6d7e8a9b0c";

/**
 * Canonicalize a URL for dedup.
 *
 * Forces https, lowercases the host, drops the port, query string and
 * fragment, and strips trailing slashes from the path. This is what lets
 * utm links, `?ref=` share links, http vs https and trailing-slash
 * variants of the same post collapse to one URL.
 */
export function normalizeUrl(url: string): string {
  const parts = new URL(url.trim());
  const host = parts.hostname.toLowerCase();
  const path = parts.pathname.replace(/\/+$/, "") || "/";
  return `https://${host}${path}`;
}

/**
 * `pub:<publicationSlug>:<post_slug>`: the cross-pipeline dedupe key.
 *
 * `publicationSlug` is passed in rather than derived from the URL's host:
 * every producer (discovery, backfill, freshness, manual add) already
 * knows which publication it is working from the allowlist, so this stays
 * a pure string function instead of doing a lookup.
 */
export function canonicalId(publicationSlug: string, url: string): string {
  const normalized = normalizeUrl(url);
  const segments = new URL(normalized).pathname.split("/").filter(Boolean);
  const postSlug = segments.at(-1);
  if (postSlug === undefined) {
    throw new Error(`URL has no path segment to use as a post slug: ${JSON.stringify(url)}`);
  }
  return `pub:${publicationSlug}:${postSlug}`;
}

/** 12 url-safe characters from 9 random bytes (same as Python's `secrets.token_urlsafe(9)`). */
function tokenUrlsafe(): string {
  return randomBytes(9).toString("base64url");
}

/**
 * `snap_<12 url-safe chars>`: the id of one answer produced by `POST /ask`.
 *
 * It joins an answer with everything recorded about it later (scores, feedback).
 */
export function snapshotId(): string {
  return `snap_${tokenUrlsafe()}`;
}

/** `res_<12 url-safe chars>`: the id of one bounded research agent run (`POST /research`). */
export function researchId(): string {
  return `res_${tokenUrlsafe()}`;
}

function normalizeForId(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ").trim().toLowerCase();
}

/**
 * Deterministic UUIDv5 for a claim extracted from a specific article revision.
 *
 * Re-running `extract-claims` on the same article revision converges on the
 * exact same UUID in both Postgres and Memgraph. The seed format matches the
 * Python version, so ids written before the TypeScript port stay stable.
 */
export function claimId(
  articleId: string,
  contentHash: string,
  quoteSpan: string,
  claimText: string,
): string {
  const seed = `${articleId}:${contentHash}:${normalizeForId(quoteSpan)}:${normalizeForId(claimText)}`;
  return Bun.randomUUIDv5(seed, ARTICLE_CLAIM_NAMESPACE);
}
