/**
 * Three-way hybrid retrieval: BM25 + pgvector + Memgraph claim traversal,
 * fused with Reciprocal Rank Fusion.
 *
 * Neither engine is enough alone:
 * - Full-text search (`sparse.ts`, Postgres `tsvector` + `ts_rank`) nails exact tokens.
 * - Vector search (`dense.ts`, pgvector) captures semantic similarity.
 * - Graph traversal (`graph.ts`, Memgraph) bridges attributed claims across
 *   publications through shared `:Topic` nodes, with no natural similarity score.
 *
 * Because RRF depends only on each candidate's ordinal POSITION (1, 2, ..., N)
 * in each ranking, all three engines fuse cleanly without score calibration.
 */

import type { Kysely } from "kysely";
import { settings } from "../config";
import { searchPassagesBm25, searchPassagesDense } from "../db/queries";
import type { DB } from "../db/types";
import { embedTexts } from "../sources/embedder";
import { searchGraphClaims } from "./graph";

type Item = Record<string, unknown>;

// A type alias, not an interface, so it is assignable to `JsonObject` (snapshot rows).
export type RetrievedCandidate = {
  passage_id: string;
  text: string;
  title: string;
  author: string | null;
  url: string;
  published_at: string;
  rrf_score: number;
  sparse_rank: number | null;
  sparse_score: number | null;
  dense_rank: number | null;
  dense_score: number | null;
  graph_rank: number | null;
  claim_id: string | null;
  claim_text: string | null;
  claim_type: string | null;
  /** "bm25", "vector", "both", "graph", "bm25+graph", "vector+graph", or "all" */
  source: string;
};

function optionalString(value: unknown): string | null {
  return value ? String(value) : null;
}

function candidate(item: Item, rrfScore: number): RetrievedCandidate {
  return {
    passage_id: String(item.passage_id),
    text: String(item.text),
    title: String(item.title),
    author: typeof item.author === "string" ? item.author : null,
    url: String(item.url),
    published_at: String(item.published_at),
    rrf_score: rrfScore,
    sparse_rank: null,
    sparse_score: null,
    dense_rank: null,
    dense_score: null,
    graph_rank: null,
    claim_id: optionalString(item.claim_id),
    claim_text: optionalString(item.claim_text),
    claim_type: optionalString(item.claim_type),
    source: "bm25",
  };
}

function formatSource(c: RetrievedCandidate): string {
  const hasBm25 = c.sparse_rank !== null;
  const hasVector = c.dense_rank !== null;
  const hasGraph = c.graph_rank !== null;
  if (hasBm25 && hasVector && hasGraph) return "all";
  if (hasBm25 && hasVector) return "both";
  if (hasBm25 && hasGraph) return "bm25+graph";
  if (hasVector && hasGraph) return "vector+graph";
  if (hasGraph) return "graph";
  if (hasVector) return "vector";
  return "bm25";
}

/** Add one engine's contribution to `cand`, or create it. Returns the candidate. */
function addContribution(
  candidates: Map<string, RetrievedCandidate>,
  item: Item,
  score: number,
): RetrievedCandidate {
  const pid = String(item.passage_id);
  const existing = candidates.get(pid);
  if (existing === undefined) {
    const created = candidate(item, score);
    candidates.set(pid, created);
    return created;
  }
  existing.rrf_score += score;
  return existing;
}

/** Each passage once per engine, at its best (first) rank. Pure. */
function dedupeByPassage(items: readonly Item[]): Array<[number, Item]> {
  const seen = new Set<string>();
  const ranked: Array<[number, Item]> = [];
  items.forEach((item, index) => {
    const pid = String(item.passage_id);
    if (seen.has(pid)) return;
    seen.add(pid);
    ranked.push([index + 1, item]);
  });
  return ranked;
}

/**
 * score(passage) = sum over engines of 1 / (k + rank in that engine).
 *
 * A passage found by multiple engines collects points from each. Ties are
 * broken by `passage_id`, so the same question always gives the same order. Pure.
 */
export function computeRrf(
  sparseResults: readonly Item[],
  denseResults: readonly Item[],
  graphResults: readonly Item[] | null = null,
  k = 60,
): RetrievedCandidate[] {
  const candidates = new Map<string, RetrievedCandidate>();

  for (const [rank, item] of dedupeByPassage(sparseResults)) {
    const cand = addContribution(candidates, item, 1.0 / (k + rank));
    cand.sparse_rank = rank;
    cand.sparse_score = Number(item.rank ?? 0.0);
  }
  for (const [rank, item] of dedupeByPassage(denseResults)) {
    const cand = addContribution(candidates, item, 1.0 / (k + rank));
    cand.dense_rank = rank;
    cand.dense_score = Number(item.rank ?? 0.0);
  }
  for (const [rank, item] of dedupeByPassage(graphResults ?? [])) {
    const cand = addContribution(candidates, item, 1.0 / (k + rank));
    if (cand.claim_id === null && item.claim_id) {
      cand.claim_id = String(item.claim_id);
      cand.claim_text = String(item.claim_text ?? "");
      cand.claim_type = String(item.claim_type ?? "");
    }
    cand.graph_rank = rank;
  }

  const fused = [...candidates.values()];
  for (const cand of fused) cand.source = formatSource(cand);
  return fused.sort(
    (a, b) =>
      b.rrf_score - a.rrf_score ||
      (a.passage_id < b.passage_id ? -1 : a.passage_id > b.passage_id ? 1 : 0),
  );
}

/** Return `[top limit passages for the prompt, every fused candidate for the snapshot]`. */
export async function hybridSearch(
  db: Kysely<DB>,
  query: string,
  limit = 5,
  fetchMultiplier = 3,
  k: number | null = null,
): Promise<[RetrievedCandidate[], RetrievedCandidate[]]> {
  const rrfK = k || settings.rrfK;
  const candidateFetchLimit = Math.max(limit * fetchMultiplier, 15);

  // Overlap the network call (embedding the question) with the full-text query,
  // then run the vector and graph queries.
  const [sparseResults, embedded] = await Promise.all([
    searchPassagesBm25(db, query, candidateFetchLimit),
    embedTexts([query]),
  ]);
  const [queryEmbedding] = embedded.embeddings;
  if (embedded.embeddings.length !== 1 || queryEmbedding === undefined) {
    throw new Error(`hybridSearch: expected 1 embedding, got ${embedded.embeddings.length}`);
  }
  const denseResults = await searchPassagesDense(db, queryEmbedding, candidateFetchLimit);
  const graphResults = await searchGraphClaims(db, query, settings.graphRetrievalLimit);

  const fused = computeRrf(sparseResults, denseResults, graphResults, rrfK);
  return [fused.slice(0, limit), fused];
}

/** Same interface as `sparse.search` and `dense.search`, used by `GET /search`. */
export async function search(
  db: Kysely<DB>,
  query: string,
  limit = 5,
): Promise<RetrievedCandidate[]> {
  const [top] = await hybridSearch(db, query, limit);
  return top;
}
