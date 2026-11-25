/**
 * Memgraph Bolt client (`neo4j-driver`), schema initialization, and graph operations.
 *
 * Integers come back as plain JS numbers (`disableLosslessIntegers`): every count
 * here fits in 2^53. Integer *parameters* (`LIMIT $limit`) must be sent with
 * `neo4j.int`, because the driver sends a JS number as a float.
 */

import neo4j, { type Driver } from "neo4j-driver";
import { settings } from "../config";
import {
  COUNT_ACTIVE_CLAIMS_AND_TOPICS_CYPHER,
  CROSS_PUBLICATION_DISAGREEMENTS_CYPHER,
  GET_CLAIM_PROVENANCE_CYPHER,
  MERGE_ARTICLE_SKELETON_CYPHER,
  MERGE_CLAIMS_BATCH_CYPHER,
  MERGE_SUPERSEDES_EDGES_CYPHER,
  SEARCH_CLAIMS_BY_TOPICS_CYPHER,
  SUPERSEDE_ARTICLE_CLAIMS_CYPHER,
} from "./cypher";

export type GraphRow = Record<string, unknown>;

export interface GraphSyncResult {
  synced_claims: number;
  superseded_claims: number;
  supersedes_edges: number;
}

// Process-wide singleton, created on first use so importing this module never connects.
let driver: Driver | undefined;
let schemaInitialized = false;

export const SCHEMA_DDL_STATEMENTS: readonly string[] = [
  // Label-property indexes for O(1) MERGE and lookup performance
  "CREATE INDEX ON :Publication(slug);",
  "CREATE INDEX ON :Author(slug);",
  "CREATE INDEX ON :Article(canonical_id);",
  "CREATE INDEX ON :Article(article_id);",
  "CREATE INDEX ON :Claim(claim_id);",
  "CREATE INDEX ON :Claim(article_id);",
  "CREATE INDEX ON :Topic(slug);",
  // Uniqueness constraints (Memgraph Cypher syntax)
  "CREATE CONSTRAINT ON (p:Publication) ASSERT p.slug IS UNIQUE;",
  "CREATE CONSTRAINT ON (a:Author) ASSERT a.slug IS UNIQUE;",
  "CREATE CONSTRAINT ON (art:Article) ASSERT art.canonical_id IS UNIQUE;",
  "CREATE CONSTRAINT ON (c:Claim) ASSERT c.claim_id IS UNIQUE;",
  "CREATE CONSTRAINT ON (t:Topic) ASSERT t.slug IS UNIQUE;",
];

/** Return the singleton Bolt driver for Memgraph. */
export function getGraphDriver(): Driver {
  driver ??= neo4j.driver(
    settings.memgraphUri,
    neo4j.auth.basic(settings.memgraphUser, settings.memgraphPassword),
    { disableLosslessIntegers: true },
  );
  return driver;
}

/** Override the singleton graph driver (used by tests). */
export function setGraphDriver(newDriver: Driver | undefined): void {
  driver = newDriver;
  schemaInitialized = false;
}

/** Close and reset the singleton graph driver. */
export async function closeGraphDriver(): Promise<void> {
  if (driver === undefined) return;
  const current = driver;
  driver = undefined;
  schemaInitialized = false;
  await current.close();
}

/** Execute a parameterized Cypher query and return rows as plain objects. */
export async function executeCypher(
  query: string,
  parameters: Record<string, unknown> = {},
): Promise<GraphRow[]> {
  const session = getGraphDriver().session();
  try {
    const result = await session.run(query, parameters);
    return result.records.map((record) => record.toObject());
  } finally {
    await session.close();
  }
}

/** Idempotently ensure Memgraph indexes and uniqueness constraints exist. */
export async function ensureGraphSchema(): Promise<void> {
  if (schemaInitialized) return;
  const session = getGraphDriver().session();
  try {
    for (const stmt of SCHEMA_DDL_STATEMENTS) {
      try {
        await session.run(stmt);
      } catch (error) {
        // Memgraph may report an error if a constraint/index already exists
        console.debug(`Memgraph schema statement skipped (${stmt}): ${String(error)}`);
      }
    }
  } finally {
    await session.close();
  }
  schemaInitialized = true;
}

/** Check whether Memgraph is reachable over Bolt and ensure schema is initialized. */
export async function checkMemgraphHealth(): Promise<string> {
  try {
    const rows = await executeCypher("RETURN 1 AS ok");
    if (rows[0]?.ok !== 1) return "error: unexpected response from Memgraph";
    await ensureGraphSchema();
    return "ok";
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** `row[key]` as a number, or `fallback` when the row or the value is missing. */
function countOf(rows: readonly GraphRow[], key: string, fallback: number): number {
  const value = rows[0]?.[key];
  if (value === undefined || value === null) return fallback;
  const count = Number(value);
  if (!Number.isFinite(count)) throw new Error(`Memgraph returned a non-numeric ${key}: ${value}`);
  return count;
}

/** Return `[active_claims, active_topics]` from Memgraph. */
export async function countGraphEntities(): Promise<[number, number]> {
  const rows = await executeCypher(COUNT_ACTIVE_CLAIMS_AND_TOPICS_CYPHER);
  return [countOf(rows, "active_claims", 0), countOf(rows, "active_topics", 0)];
}

export interface ArticleGraphSync {
  pubSlug: string;
  pubName: string;
  pubHomepage: string;
  authorSlug: string;
  authorName: string;
  canonicalId: string;
  articleId: string;
  url: string;
  title: string;
  publishedAt: string;
  contentHash: string;
  /** ValidatedClaim JSON plus `valid_from` / `valid_to`. */
  claims: readonly Record<string, unknown>[];
  /** `[{ new_claim_id, old_claim_id, at }]` from `persistArticleClaims`. */
  supersedesPairs?: readonly Record<string, string>[] | null;
  nowIso: string;
}

function mergeArticleSkeleton(sync: ArticleGraphSync): Promise<GraphRow[]> {
  return executeCypher(MERGE_ARTICLE_SKELETON_CYPHER, {
    pub_slug: sync.pubSlug,
    pub_name: sync.pubName,
    pub_homepage: sync.pubHomepage,
    author_slug: sync.authorSlug,
    author_name: sync.authorName,
    canonical_id: sync.canonicalId,
    article_id: sync.articleId,
    url: sync.url,
    title: sync.title,
    published_at: sync.publishedAt,
    content_hash: sync.contentHash,
  });
}

/**
 * Idempotently synchronize an article's skeleton, active claims, topics,
 * and supersession edges into Memgraph.
 */
export async function syncArticleClaimsToGraph(sync: ArticleGraphSync): Promise<GraphSyncResult> {
  if (!sync.canonicalId) throw new Error("syncArticleClaimsToGraph: canonicalId is empty");
  await ensureGraphSchema();
  await mergeArticleSkeleton(sync);

  const activeClaimIds = sync.claims.map((c) => String(c.claim_id));
  const supersededRows = await executeCypher(SUPERSEDE_ARTICLE_CLAIMS_CYPHER, {
    canonical_id: sync.canonicalId,
    active_claim_ids: activeClaimIds,
    now: sync.nowIso,
  });

  let syncedClaims = 0;
  if (sync.claims.length > 0) {
    const batchRows = await executeCypher(MERGE_CLAIMS_BATCH_CYPHER, {
      canonical_id: sync.canonicalId,
      claims: sync.claims,
    });
    syncedClaims = countOf(batchRows, "synced_claims", sync.claims.length);
  }

  const pairs = sync.supersedesPairs ?? [];
  let supersedesEdges = 0;
  if (pairs.length > 0) {
    const edgeRows = await executeCypher(MERGE_SUPERSEDES_EDGES_CYPHER, {
      supersedes_pairs: pairs,
    });
    supersedesEdges = countOf(edgeRows, "supersedes_edges", pairs.length);
  }

  return {
    synced_claims: syncedClaims,
    superseded_claims: countOf(supersededRows, "superseded_count", 0),
    supersedes_edges: supersedesEdges,
  };
}

/** Run the 2-hop topic-to-claim Cypher traversal over active claims. */
export async function searchGraphByTopics(options: {
  topicSlugs: readonly string[];
  searchTerms: readonly string[];
  limit: number;
}): Promise<GraphRow[]> {
  if (options.topicSlugs.length === 0 && options.searchTerms.length === 0) return [];
  return executeCypher(SEARCH_CLAIMS_BY_TOPICS_CYPHER, {
    topic_slugs: options.topicSlugs,
    search_terms: options.searchTerms,
    limit: neo4j.int(options.limit),
  });
}

/** Fetch claim provenance and connected topic nodes from Memgraph. */
export async function getClaimProvenanceFromGraph(
  claimId: string,
  options: { includeSuperseded?: boolean } = {},
): Promise<GraphRow | null> {
  const rows = await executeCypher(GET_CLAIM_PROVENANCE_CYPHER, {
    claim_id: claimId,
    include_superseded: options.includeSuperseded ?? true,
  });
  return rows[0] ?? null;
}

/** Traverse Author 1 -> Article -> Claim -> Topic <- Claim <- Article <- Author 2. */
export async function findCrossPublicationSharedTopicClaims(limit = 25): Promise<GraphRow[]> {
  return executeCypher(CROSS_PUBLICATION_DISAGREEMENTS_CYPHER, { limit: neo4j.int(limit) });
}
