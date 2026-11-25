/**
 * Basic tests: small, fast, and no infrastructure needed.
 *
 * Run them with `bun test`. They don't need Docker, Postgres, Inngest or an
 * OpenAI key, because they only test the small pure functions the pipeline is
 * built from:
 *
 *     URL  ->  canonicalId  ->  allowlist check  ->  chunkText
 *
 * Each test is a few lines and says what it proves in its name.
 */

import { expect, test } from "bun:test";
import { canonicalId, normalizeUrl } from "../kb/schemas/ids";
import { assertAllowed, PublicationEntry } from "../kb/sources/allowlist";
import { chunkText } from "../kb/sources/chunking";
import { parseFeed } from "../kb/sources/rss";

// --- 1. URLs: the same article must always get the same id ------------------

test("tracking params and trailing slash are removed", () => {
  const messy = "http://TheNeuralMaze.substack.com/p/my-post/?utm_source=x#top";
  expect(normalizeUrl(messy)).toBe("https://theneuralmaze.substack.com/p/my-post");
});

test("canonical id is publication plus post slug", () => {
  const url = "https://theneuralmaze.substack.com/p/my-post?ref=share";
  expect(canonicalId("the-neural-maze", url)).toBe("pub:the-neural-maze:my-post");
});

// --- 2. Allowlist: we only ingest from publications.yaml -------------------

const NEURAL_MAZE = PublicationEntry.parse({
  slug: "the-neural-maze",
  name: "The Neural Maze",
  feed_url: "https://theneuralmaze.substack.com/feed",
  homepage: "https://theneuralmaze.substack.com",
});

test("allowed url passes", () => {
  const url = "https://theneuralmaze.substack.com/p/my-post";
  expect(assertAllowed(url, [NEURAL_MAZE]).slug).toBe("the-neural-maze");
});

test("unknown site is rejected", () => {
  expect(() => assertAllowed("https://random-blog.example.com/post", [NEURAL_MAZE])).toThrow(
    "outside the allowlist",
  );
});

// --- 3. Chunking: long text becomes overlapping pieces ----------------------

const TEXT = "the quick brown fox jumps over the lazy dog while the cat watches";

test("short text stays in one chunk", () => {
  expect(chunkText(TEXT, { chunkSize: 1000, chunkOverlap: 10 })).toEqual([TEXT]);
});

test("long text is split and no chunk is too big", () => {
  const chunks = chunkText(TEXT, { chunkSize: 30, chunkOverlap: 10 });
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((chunk) => chunk.length <= 30)).toBe(true);
});

test("neighbouring chunks share some words", () => {
  const chunks = chunkText(TEXT, { chunkSize: 30, chunkOverlap: 10 });
  for (const [i, second] of chunks.slice(1).entries()) {
    const first = new Set((chunks[i] ?? "").split(" "));
    expect(second.split(" ").some((word) => first.has(word))).toBe(true);
  }
});

test("a word longer than the chunk size gets its own chunk and chunking ends", () => {
  const long = "x".repeat(50);
  expect(chunkText(`${long} tail`, { chunkSize: 30, chunkOverlap: 10 })).toEqual([long, "tail"]);
});

test("overlap must be smaller than chunk size", () => {
  expect(() => chunkText(TEXT, { chunkSize: 10, chunkOverlap: 10 })).toThrow("chunk_overlap");
});

// --- 4. RSS: turn a feed into a list of articles ----------------------------

const FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Demo</title>
  <item>
    <title>First post</title>
    <link>https://theneuralmaze.substack.com/p/first-post</link>
    <pubDate>Tue, 16 Sep 2025 09:48:40 GMT</pubDate>
  </item>
</channel></rss>`;

test("feed entries are parsed", async () => {
  const [entry, ...rest] = await parseFeed(FEED);
  expect(rest).toHaveLength(0);
  expect(entry?.title).toBe("First post");
  expect(entry?.url).toBe("https://theneuralmaze.substack.com/p/first-post");
  expect(entry?.published_at.getUTCFullYear()).toBe(2025);
});

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Demo</title>
  <entry>
    <title>Atom post</title>
    <link href="https://example.com/p/atom-post"/>
    <updated>2025-09-16T09:48:40Z</updated>
  </entry>
  <entry><title>No link or date</title></entry>
</feed>`;

test("atom entries are parsed and malformed entries are skipped", async () => {
  const entries = await parseFeed(ATOM);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.url).toBe("https://example.com/p/atom-post");
  expect(entries[0]?.published_at.toISOString()).toBe("2025-09-16T09:48:40.000Z");
});

test("a feed that does not parse fails clearly", async () => {
  await expect(parseFeed("not xml at all <")).rejects.toThrow("Feed did not parse");
});
