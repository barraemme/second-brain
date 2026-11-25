/**
 * Flow-control and retrieval tests: same rules as basics.test.ts, no Docker, database or API key.
 *
 * They cover the parts of ingestion and retrieval that are pure logic or pure configuration:
 *
 *     RRF fusion  ->  ingest-article's flow control  ->  allowlist & ids for 3 publications
 */

import { describe, expect, test } from "bun:test";
import { loadSettings, settings } from "../kb/config";
import { ingestArticle } from "../kb/functions/ingest";
import { computeRrf } from "../kb/retrieval/hybrid";
import { canonicalId, snapshotId } from "../kb/schemas/ids";
import { findPublicationForUrl, loadPublications } from "../kb/sources/allowlist";

function passage(pid: string): Record<string, unknown> {
  return {
    passage_id: pid,
    text: `text of ${pid}`,
    title: "A title",
    author: null,
    url: `https://example.com/p/${pid}`,
    published_at: "2026-09-30T00:00:00+00:00",
    rank: 0.5,
  };
}

// --- 1. RRF: positions, not scores ------------------------------------------

describe("RRF", () => {
  test("agreement between engines beats one engine's favourite", () => {
    // A: keyword #1, vector #2. C: keyword #3, vector #5. B: only vector #1.
    const sparse = [passage("A"), passage("X"), passage("C")];
    const dense = [passage("B"), passage("A"), passage("Y"), passage("Z"), passage("C")];
    const order = computeRrf(sparse, dense, null, 60).map((c) => c.passage_id);
    expect(order.indexOf("A")).toBeLessThan(order.indexOf("C"));
    expect(order.indexOf("C")).toBeLessThan(order.indexOf("B"));
  });

  test("score is the sum of 1 / (k + rank)", () => {
    const fused = new Map(
      computeRrf([passage("A")], [passage("B"), passage("A")]).map((c) => [c.passage_id, c]),
    );
    const a = fused.get("A");
    const b = fused.get("B");
    expect(a?.rrf_score).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(a?.source).toBe("both");
    expect([a?.sparse_rank, a?.dense_rank]).toEqual([1, 2]);
    expect(b?.source).toBe("vector");
  });

  test("ties are broken by passage_id so results are deterministic", () => {
    const fused = computeRrf([passage("b")], [passage("a")]);
    expect(fused.map((c) => c.passage_id)).toEqual(["a", "b"]);
  });
});

// --- 2. Flow control lives on ingest-article itself -------------------------

describe("ingest-article flow control", () => {
  const opts = ingestArticle.opts;

  test("concurrency is keyed per publication", () => {
    expect(opts.concurrency).toEqual([
      { key: "event.data.publication_id", limit: settings.concurrencyPerPublication },
    ]);
  });

  test("runs are throttled globally", () => {
    expect(opts.throttle).toBeDefined();
    // One OpenAI quota, shared by every publication.
    expect(opts.throttle?.key).toBeUndefined();
  });

  test("manual runs are shifted ahead and backfill runs behind", () => {
    const defaults = loadSettings({});
    expect(defaults.priorityManualS).toBe(600);
    expect(defaults.priorityBackfillS).toBe(-600);
    expect(opts.priority?.run).toBe(
      `event.data.via == 'manual' ? ${settings.priorityManualS} : ${settings.priorityBackfillS}`,
    );
  });

  test("no idempotency key, so re-adding a publication still retries failed articles", () => {
    expect(opts.idempotency).toBeUndefined();
  });
});

// --- 3. Three publications, one id per article ------------------------------

describe("publications and ids", () => {
  test("substack and custom-domain URLs belong to the same publication", () => {
    const pubs = loadPublications();
    for (const url of [
      "https://www.theneuralmaze.com/p/some-post",
      "https://theneuralmaze.substack.com/p/some-post",
    ]) {
      expect(findPublicationForUrl(url, pubs)?.slug).toBe("the-neural-maze");
    }
  });

  test("the same post gets the same id on either domain", () => {
    const a = canonicalId("the-neural-maze", "https://www.theneuralmaze.com/p/some-post/");
    const b = canonicalId(
      "the-neural-maze",
      "https://theneuralmaze.substack.com/p/some-post?ref=x",
    );
    expect(a).toBe("pub:the-neural-maze:some-post");
    expect(b).toBe(a);
  });

  test("snapshot ids are prefixed and unique", () => {
    const ids = new Set(Array.from({ length: 100 }, () => snapshotId()));
    expect(ids.size).toBe(100);
    for (const id of ids) {
      expect(id.startsWith("snap_")).toBe(true);
      expect(id).toHaveLength(17);
    }
  });
});
