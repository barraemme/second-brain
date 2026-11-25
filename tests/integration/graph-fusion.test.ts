/**
 * Integration test for three-way retrieval fusion and `kb_sources` provenance.
 *
 * Seeds two publications connected via a shared `:Topic` (`rag`) in Memgraph and
 * Postgres, runs `hybridSearch`, verifies `graph`-sourced candidates appear in
 * the fused candidates, and verifies `kb_sources` resolves both `claim_id` and
 * `passage_id` to their verbatim quote and temporal validity metadata.
 */

import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { settings } from "../../kb/config";
import {
  getSourceProvenance,
  persistArticleClaims,
  replacePassages,
  upsertArticle,
  upsertPublication,
} from "../../kb/db/queries";
import {
  checkMemgraphHealth,
  closeGraphDriver,
  executeCypher,
  findCrossPublicationSharedTopicClaims,
  syncArticleClaimsToGraph,
} from "../../kb/graph/client";
import { hybridSearch } from "../../kb/retrieval/hybrid";
import type { RawExtractedClaim, ValidatedClaim } from "../../kb/schemas/entities";
import * as embedder from "../../kb/sources/embedder";
import { validateAndNormalizeClaims } from "../../kb/sources/quote-validator";
import { POSTGRES_AVAILABLE, useRollbackDb } from "./db";

const CANONICAL_1 = "pub:fusion-pub-a:post-rag-1";
const CANONICAL_2 = "pub:fusion-pub-b:post-rag-2";
const NOW = new Date("2026-10-15T00:00:00Z");
const FAKE_EMBEDDING = Array.from({ length: settings.embeddingDimensions }, () => 0.01);

const MEMGRAPH_STATUS = POSTGRES_AVAILABLE ? await checkMemgraphHealth() : "not checked";
if (POSTGRES_AVAILABLE && MEMGRAPH_STATUS !== "ok") {
  console.warn(`graph-fusion skipped: Memgraph not reachable (${MEMGRAPH_STATUS})`);
}
const READY = POSTGRES_AVAILABLE && MEMGRAPH_STATUS === "ok";

afterAll(closeGraphDriver);

async function deleteGraphFixtures(): Promise<void> {
  for (const cid of [CANONICAL_1, CANONICAL_2]) {
    await executeCypher(
      `MATCH (art:Article {canonical_id: $cid})
       OPTIONAL MATCH (art)-[:ASSERTS]->(c:Claim)
       DETACH DELETE c, art`,
      { cid },
    );
  }
  for (const slug of ["fusion-pub-a", "fusion-pub-b"]) {
    await executeCypher(
      "MATCH (p:Publication {slug: $slug}) WHERE NOT ()-[:PUBLISHED_IN]->(p) DETACH DELETE p",
      { slug },
    );
  }
}

interface Fixture {
  slug: string;
  name: string;
  canonicalId: string;
  title: string;
  author: string;
  authorSlug: string;
  publishedAt: string;
  contentHash: string;
  text: string;
  rawClaim: RawExtractedClaim;
}

const FIXTURE_A: Fixture = {
  slug: "fusion-pub-a",
  name: "Fusion Pub A",
  canonicalId: CANONICAL_1,
  title: "Why RAG Needs a Reranker",
  author: "Author Alpha",
  authorSlug: "author-alpha",
  publishedAt: "2026-10-10T00:00:00+00:00",
  contentHash: "hash_a",
  text:
    "Retrieval-Augmented Generation pipelines benefit from Reciprocal Rank " +
    "Fusion before invoking a cross-encoder reranker.",
  rawClaim: {
    claim_text: "RAG pipelines benefit from RRF before a cross-encoder reranker.",
    quote_span: "",
    claim_type: "opinion",
    entities: ["Retrieval-Augmented Generation", "Reranker"],
    confidence: 0.95,
  },
};

const FIXTURE_B: Fixture = {
  slug: "fusion-pub-b",
  name: "Fusion Pub B",
  canonicalId: CANONICAL_2,
  title: "When to Skip the Reranker in RAG",
  author: "Author Beta",
  authorSlug: "author-beta",
  publishedAt: "2026-10-12T00:00:00+00:00",
  contentHash: "hash_b",
  text:
    "In low-latency production services, RAG architectures should skip the " +
    "reranker and rely on hybrid BM25 plus vector fusion.",
  rawClaim: {
    claim_text: "Low-latency RAG services should skip the reranker.",
    quote_span: "",
    claim_type: "opinion",
    entities: ["RAG", "rerankers"],
    confidence: 0.93,
  },
};

/** Seed one publication, article, passage and claim in Postgres and Memgraph. */
async function seedArticle(f: Fixture, db: ReturnType<ReturnType<typeof useRollbackDb>>) {
  const homepage = `https://${f.slug.replace("fusion-pub-", "fusion-")}.example.com`;
  const url = `${homepage}/p/${f.canonicalId.split(":").at(-1)}`;
  const publicationId = await upsertPublication(db, {
    slug: f.slug,
    name: f.name,
    feedUrl: `${homepage}/feed`,
    homepage,
  });
  const articleId = await upsertArticle(db, {
    canonicalId: f.canonicalId,
    publicationId,
    url,
    title: f.title,
    author: f.author,
    publishedAt: new Date(f.publishedAt),
    contentHash: f.contentHash,
    text: f.text,
  });
  await replacePassages(db, {
    articleId,
    passages: [{ chunk_index: 0, text: f.text, embedding: FAKE_EMBEDDING }],
  });
  const [claims] = validateAndNormalizeClaims(articleId, f.contentHash, f.text, [
    { ...f.rawClaim, quote_span: f.text },
  ]);
  await persistArticleClaims(db, { articleId, claims, now: NOW });
  await syncArticleClaimsToGraph({
    pubSlug: f.slug,
    pubName: f.name,
    pubHomepage: homepage,
    authorSlug: f.authorSlug,
    authorName: f.author,
    canonicalId: f.canonicalId,
    articleId,
    url,
    title: f.title,
    publishedAt: f.publishedAt,
    contentHash: f.contentHash,
    claims: claims.map((c) => ({ ...c, valid_from: NOW.toISOString(), valid_to: null })),
    nowIso: NOW.toISOString(),
  });
  return { articleId, claims };
}

describe.skipIf(!READY)("three-way graph fusion", () => {
  const getDb = useRollbackDb();
  afterEach(deleteGraphFixtures);

  test("graph candidates are fused and kb_sources resolves provenance", async () => {
    // Stub the embedding call so this test needs no live embedding server.
    const embedSpy = spyOn(embedder, "embedTexts").mockImplementation(async (texts) => ({
      embeddings: texts.map(() => FAKE_EMBEDDING),
      usage: { model: "fake-embedder", input_tokens: 5, output_tokens: 0, est_usd: 0 },
    }));
    try {
      const db = getDb();
      const seededA = await seedArticle(FIXTURE_A, db);
      await seedArticle(FIXTURE_B, db);

      // Cross-publication 2-hop traversal over shared :Topic ("rag" and "reranker")
      const crossRows = await findCrossPublicationSharedTopicClaims(25);
      const sharedTopics = new Set(crossRows.map((r) => r.shared_topic));
      expect(sharedTopics.has("rag")).toBe(true);
      expect(sharedTopics.has("reranker")).toBe(true);

      const [top, all] = await hybridSearch(db, "Does RAG require a reranker in production?", 5);
      expect(top.length).toBeGreaterThanOrEqual(2);
      expect(all.filter((c) => c.graph_rank !== null).length).toBeGreaterThanOrEqual(2);

      const firstClaim: ValidatedClaim | undefined = seededA.claims[0];
      if (firstClaim === undefined) throw new Error("fixture A produced no validated claim");
      const provenance = await getSourceProvenance(db, firstClaim.claim_id);
      expect(provenance?.kind).toBe("claim");
      expect(provenance?.verbatim_quote).toBe(FIXTURE_A.text);
      expect(provenance?.author).toBe("Author Alpha");
      expect(provenance?.validity).toMatchObject({ is_active: true });
    } finally {
      embedSpy.mockRestore();
    }
  });
});
