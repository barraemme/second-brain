/**
 * Integration tests for claim extraction, Memgraph idempotency, and supersession.
 *
 * Verifies against real Postgres and Memgraph (skipped if the local dev stack is not up):
 * 1. Persisting validated claims writes rows to Postgres `claims` and merges
 *    `:Publication`, `:Author`, `:Article`, `:Claim`, `:Topic` into Memgraph.
 * 2. Re-running the identical sync creates ZERO duplicate nodes or edges.
 * 3. Updating an article (`kb/article.updated`) sets `valid_to` on superseded claims
 *    and creates `[:SUPERSEDES]` edges in Memgraph (and `supersedes_id` in Postgres).
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  getActiveClaimsForArticle,
  persistArticleClaims,
  upsertArticle,
  upsertPublication,
} from "../../kb/db/queries";
import {
  type ArticleGraphSync,
  checkMemgraphHealth,
  closeGraphDriver,
  executeCypher,
  syncArticleClaimsToGraph,
} from "../../kb/graph/client";
import { normalizeAuthor } from "../../kb/graph/ontology";
import { RawExtractedClaim, type ValidatedClaim } from "../../kb/schemas/entities";
import { validateAndNormalizeClaims } from "../../kb/sources/quote-validator";
import { POSTGRES_AVAILABLE, useRollbackDb } from "./db";

const TEST_CANONICAL_ID = "pub:claims-test-pub:memgraph-idempotency-post";
const TEST_PUB_SLUG = "claims-test-pub";
const ARTICLE_URL = "https://claims-test.example.com/p/memgraph-idempotency-post";
const ARTICLE_TITLE = "Graph Ontology and Idempotent Enrichment";

const MEMGRAPH_STATUS = await checkMemgraphHealth();
if (MEMGRAPH_STATUS !== "ok") {
  console.warn(`Memgraph integration tests skipped: not reachable (${MEMGRAPH_STATUS})`);
}
const STACK_UP = POSTGRES_AVAILABLE && MEMGRAPH_STATUS === "ok";

afterAll(closeGraphDriver);

/** Remove the test subgraph from Memgraph (Postgres rows roll back on their own). */
async function deleteTestSubgraph(): Promise<void> {
  await executeCypher(
    `MATCH (art:Article {canonical_id: $cid})
     OPTIONAL MATCH (art)-[:ASSERTS]->(c:Claim)
     DETACH DELETE c, art`,
    { cid: TEST_CANONICAL_ID },
  );
  await executeCypher(
    "MATCH (p:Publication {slug: $slug}) WHERE NOT ()-[:PUBLISHED_IN]->(p) DETACH DELETE p",
    { slug: TEST_PUB_SLUG },
  );
}

function graphSync(
  articleId: string,
  contentHash: string,
  claims: readonly ValidatedClaim[],
  now: Date,
  supersedesPairs: readonly Record<string, string>[],
): ArticleGraphSync {
  const author = normalizeAuthor("Miguel Otero Pedrido");
  return {
    pubSlug: TEST_PUB_SLUG,
    pubName: "Test Publication",
    pubHomepage: "https://claims-test.example.com",
    authorSlug: author.slug,
    authorName: author.name,
    canonicalId: TEST_CANONICAL_ID,
    articleId,
    url: ARTICLE_URL,
    title: ARTICLE_TITLE,
    publishedAt: "2026-10-15T00:00:00+00:00",
    contentHash,
    claims: claims.map((c) => ({ ...c, valid_from: now.toISOString(), valid_to: null })),
    supersedesPairs,
    nowIso: now.toISOString(),
  };
}

const V1_TEXT =
  "Reciprocal Rank Fusion combines BM25 lexical search and pgvector cosine " +
  "similarity without requiring score calibration. Conditional HTTP 304 polling " +
  "completes in under 15ms and emits zero downstream events.";

const RAW_V1 = [
  {
    claim_text: "RRF fuses BM25 and pgvector rankings without score calibration.",
    quote_span:
      "Reciprocal Rank Fusion combines BM25 lexical search and pgvector " +
      "cosine similarity without requiring score calibration.",
    claim_type: "opinion",
    entities: ["Reciprocal Rank Fusion", "BM25", "pgvector"],
    confidence: 0.95,
  },
  {
    claim_text: "Conditional HTTP 304 polling completes in under 15ms.",
    quote_span:
      "Conditional HTTP 304 polling completes in under 15ms and emits zero downstream events.",
    claim_type: "measurement",
    entities: ["Inngest"],
    confidence: 0.92,
  },
].map((claim) => RawExtractedClaim.parse(claim));

const V2_TEXT =
  "Three-way Reciprocal Rank Fusion combines BM25, pgvector, and Memgraph " +
  "traversal into a single deterministic ranking.";

const RAW_V2 = [
  RawExtractedClaim.parse({
    claim_text: "Three-way RRF fuses BM25, pgvector, and Memgraph into one ranking.",
    quote_span:
      "Three-way Reciprocal Rank Fusion combines BM25, pgvector, and " +
      "Memgraph traversal into a single deterministic ranking.",
    claim_type: "opinion",
    entities: ["Reciprocal Rank Fusion", "Memgraph"],
    confidence: 0.98,
  }),
];

describe.skipIf(!STACK_UP)("enrich: Postgres + Memgraph", () => {
  const db = useRollbackDb();
  afterEach(deleteTestSubgraph);

  async function seedArticle(): Promise<string> {
    const pubId = await upsertPublication(db(), {
      slug: TEST_PUB_SLUG,
      name: "Test Publication",
      feedUrl: "https://claims-test.example.com/feed",
      homepage: "https://claims-test.example.com",
    });
    return upsertArticle(db(), {
      canonicalId: TEST_CANONICAL_ID,
      publicationId: pubId,
      url: ARTICLE_URL,
      title: ARTICLE_TITLE,
      author: "Miguel Otero Pedrido",
      publishedAt: new Date("2026-10-15T00:00:00Z"),
      contentHash: "hash_v1",
      text: V1_TEXT,
    });
  }

  test("idempotent sync and supersession", async () => {
    const articleId = await seedArticle();
    const [validatedV1, droppedV1] = validateAndNormalizeClaims(
      articleId,
      "hash_v1",
      V1_TEXT,
      RAW_V1,
    );
    expect(droppedV1).toBe(0);
    expect(validatedV1).toHaveLength(2);
    const nowV1 = new Date("2026-10-15T12:00:00Z");

    // --- 1. First execution, then 2. replay of the exact same event ---
    for (let run = 0; run < 2; run++) {
      const pairs = await persistArticleClaims(db(), {
        articleId,
        claims: validatedV1,
        now: nowV1,
      });
      expect(pairs).toEqual([]);
      await syncArticleClaimsToGraph(graphSync(articleId, "hash_v1", validatedV1, nowV1, []));
    }

    expect(await getActiveClaimsForArticle(db(), articleId)).toHaveLength(2);
    const graphCounts = await executeCypher(
      `MATCH (art:Article {canonical_id: $cid})-[r:ASSERTS]->(c:Claim)
       WHERE c.valid_to IS NULL
       RETURN count(DISTINCT art) AS articles,
              count(r) AS assert_edges,
              count(DISTINCT c) AS active_claims`,
      { cid: TEST_CANONICAL_ID },
    );
    expect(graphCounts[0]).toEqual({ articles: 1, assert_edges: 2, active_claims: 2 });

    // --- 3. Simulate article edit (kb/article.updated) ---
    const [validatedV2, droppedV2] = validateAndNormalizeClaims(
      articleId,
      "hash_v2",
      V2_TEXT,
      RAW_V2,
    );
    expect(droppedV2).toBe(0);
    const nowV2 = new Date("2026-10-16T12:00:00Z");

    const supersedesPairs = await persistArticleClaims(db(), {
      articleId,
      claims: validatedV2,
      now: nowV2,
    });
    expect(supersedesPairs).toHaveLength(1);
    expect(supersedesPairs[0]?.new_claim_id).toBe(validatedV2[0]?.claim_id);

    await syncArticleClaimsToGraph(
      graphSync(articleId, "hash_v2", validatedV2, nowV2, supersedesPairs),
    );

    // Postgres has 1 active claim and 2 superseded claims
    const allPgClaims = await db()
      .selectFrom("claims")
      .selectAll()
      .where("article_id", "=", articleId)
      .execute();
    expect(allPgClaims).toHaveLength(3);
    const activeAfter = allPgClaims.filter((c) => c.valid_to === null);
    expect(activeAfter).toHaveLength(1);
    expect(allPgClaims.filter((c) => c.valid_to !== null)).toHaveLength(2);
    expect(activeAfter[0]?.supersedes_id).toBe(validatedV1[0]?.claim_id ?? "");

    // Memgraph has the [:SUPERSEDES] edge and valid_to set on old claims
    const supRows = await executeCypher(
      `MATCH (new_c:Claim {claim_id: $new_id})-[r:SUPERSEDES]->(old_c:Claim)
       WHERE new_c.valid_to IS NULL AND old_c.valid_to IS NOT NULL
       RETURN new_c.claim_id AS new_id, old_c.claim_id AS old_id, r.at AS at`,
      { new_id: validatedV2[0]?.claim_id ?? "" },
    );
    expect(supRows).toHaveLength(1);
    expect(supRows[0]?.old_id).toBe(validatedV1[0]?.claim_id);
  });
});
