/**
 * publications.yaml is the allowlist. Ingestion refuses any URL outside it.
 *
 * Pure functions, no I/O beyond reading the yaml file: unit-testable without
 * Inngest or a database. The `check-allowlist` step in `kb/functions/ingest.ts`
 * calls `assertAllowed` and turns its error into `NonRetriableError`.
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { settings } from "../config";
import { hostOf } from "./url-guard";

export const PublicationEntry = z.object({
  slug: z.string(),
  name: z.string(),
  feed_url: z.string(),
  homepage: z.string(),
  notes: z.string().nullable().default(null),
  archive_urls: z.array(z.string()).nullable().default(null),
  sitemap_url: z.string().nullable().default(null),
});
export type PublicationEntry = z.infer<typeof PublicationEntry>;

const PublicationsFile = z.object({ publications: z.array(PublicationEntry) });

/** Read and validate `publications.yaml`. */
export function loadPublications(path: string = settings.publicationsFile): PublicationEntry[] {
  const raw: unknown = parse(readFileSync(path, "utf8"));
  return PublicationsFile.parse(raw).publications;
}

function allowedHosts(pub: PublicationEntry): Set<string> {
  const hosts = new Set([hostOf(pub.homepage), hostOf(pub.feed_url)]);
  for (const url of pub.archive_urls ?? []) hosts.add(hostOf(url));
  if (pub.sitemap_url) hosts.add(hostOf(pub.sitemap_url));
  return hosts;
}

/**
 * Match a candidate article URL to an allowlisted publication by exact host.
 *
 * Exact match only (no subdomain wildcarding, no substring matching), so a
 * lookalike host (`evil-theneuralmaze.example.com`) or an unlisted
 * subdomain never passes.
 */
export function findPublicationForUrl(
  url: string,
  publications: readonly PublicationEntry[],
): PublicationEntry | null {
  const host = hostOf(url);
  if (!host) return null;
  return publications.find((pub) => allowedHosts(pub).has(host)) ?? null;
}

/**
 * The allowlisted publication for `url`, or a `web-<host>` publication for any other host.
 *
 * One publication per host keeps `canonicalId` stable and keeps `ingest-article`'s
 * per-publication concurrency limit per website. A web publication has no feed, and
 * the poller never sees it: `poll-feeds` reads only `publications.yaml`.
 */
export function publicationForManualUrl(
  url: string,
  publications: readonly PublicationEntry[],
): PublicationEntry {
  const pub = findPublicationForUrl(url, publications);
  if (pub !== null) return pub;
  const host = hostOf(url);
  if (!host) throw new Error(`URL has no host: ${JSON.stringify(url)}`);
  return PublicationEntry.parse({
    slug: `web-${host.replaceAll(".", "-")}`,
    name: host,
    feed_url: "",
    homepage: `https://${host}`,
  });
}

/** Reject anything outside `publications.yaml`. */
export function assertAllowed(
  url: string,
  publications: readonly PublicationEntry[],
): PublicationEntry {
  const pub = findPublicationForUrl(url, publications);
  if (pub === null) {
    throw new Error(`URL is outside the allowlist (publications.yaml): ${JSON.stringify(url)}`);
  }
  return pub;
}
