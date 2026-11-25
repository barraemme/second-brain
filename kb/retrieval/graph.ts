/**
 * Graph-based claim retrieval over Memgraph (`kb/retrieval/graph.ts`).
 *
 * Extracts normalized topic seeds from a user query, traverses active `:Claim`
 * nodes connected to matching `:Topic` hubs in Memgraph (`WHERE c.valid_to IS NULL`),
 * and resolves their parent Postgres passages so 3-way Reciprocal Rank Fusion
 * can fuse BM25, pgvector, and graph candidates on a single ordinal scale.
 */

import type { Kysely } from "kysely";
import { settings } from "../config";
import { findMatchingPassageForQuote } from "../db/queries";
import type { DB, JsonObject } from "../db/types";
import { searchGraphByTopics } from "../graph/client";
import { normalizeTopic, STOP_TOPICS, TOPIC_ALIASES } from "../graph/ontology";

const QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  ...STOP_TOPICS,
  "what",
  "which",
  "who",
  "how",
  "why",
  "when",
  "where",
  "does",
  "do",
  "did",
  "is",
  "are",
  "was",
  "were",
  "should",
  "can",
  "could",
  "would",
  "will",
  "have",
  "has",
  "had",
  "about",
  "across",
  "between",
  "from",
  "with",
  "into",
  "over",
  "under",
  "the",
  "and",
  "for",
  "not",
  "that",
  "this",
  "these",
  "those",
  "their",
  "there",
  "whether",
  "disagree",
  "agree",
  "authors",
  "publications",
  "newsletters",
  "engineers",
  "design",
  "production",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SEARCH_TERMS = 8;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Deterministically extract `[topicSlugs, searchTerms]` from a natural-language query. Pure. */
export function extractQuerySeedTopics(query: string): [string[], string[]] {
  const lowered = query.toLowerCase();
  const slugs: string[] = [];
  const addSlug = (s: string) => {
    if (s && !slugs.includes(s) && !QUERY_STOPWORDS.has(s)) slugs.push(s);
  };

  // 1. Check multi-word and acronym aliases from TOPIC_ALIASES
  for (const [aliasKey, [canonicalSlug]] of TOPIC_ALIASES) {
    if (new RegExp(`\\b${escapeRegExp(aliasKey)}\\b`).test(lowered)) addSlug(canonicalSlug);
  }

  // 2. Extract alphabetic/alphanumeric tokens and check unigrams, bigrams, trigrams
  const tokens = (lowered.match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? []).filter(
    (t) => !QUERY_STOPWORDS.has(t) && t.length >= 2,
  );
  for (const n of [3, 2, 1]) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const topic = normalizeTopic(tokens.slice(i, i + n).join(" "));
      if (topic !== null) addSlug(topic.slug);
    }
  }

  const searchTerms = tokens.filter((t) => t.length >= 3).slice(0, MAX_SEARCH_TERMS);
  return [slugs, searchTerms];
}

/** Python's `str(row.get(key, fallback))` for a graph row value. Pure. */
function field(row: Record<string, unknown>, key: string, fallback: string): string {
  const value = row[key];
  return value === undefined || value === null ? fallback : String(value);
}

async function findPassageForClaim(
  db: Kysely<DB>,
  articleId: string,
  quoteSpan: string,
): Promise<JsonObject | null> {
  if (!UUID_RE.test(articleId)) return null;
  try {
    return await findMatchingPassageForQuote(db, { articleId, quoteSpan });
  } catch (error) {
    console.warn(`graph retrieval: passage lookup failed for article ${articleId}: ${error}`);
    return null;
  }
}

async function toCandidate(db: Kysely<DB>, row: Record<string, unknown>): Promise<JsonObject> {
  const quoteSpan = field(row, "quote_span", "");
  const claimId = field(row, "claim_id", "");
  const claimText = field(row, "claim_text", "");
  const claimFields = {
    claim_id: claimId,
    claim_text: claimText,
    claim_type: field(row, "claim_type", "opinion"),
    quote_span: quoteSpan,
    matched_topics: Number(row.matched_topics ?? 1) || 1,
    rank: Number(row.confidence ?? 0.9) || 0.9,
  };
  const match = await findPassageForClaim(db, field(row, "article_id", ""), quoteSpan);
  if (match !== null) {
    return {
      passage_id: String(match.passage_id),
      text: String(match.text),
      title: String(match.title),
      author: match.author || (row.author ?? null),
      url: String(match.url),
      published_at: String(match.published_at),
      ...claimFields,
    };
  }
  // Fallback if passage rows aren't present: surface the verified claim directly
  return {
    passage_id: claimId,
    text: `${claimText} - "${quoteSpan}"`,
    title: field(row, "title", "Unknown"),
    author: row.author ?? null,
    url: field(row, "url", ""),
    published_at: field(row, "published_at", ""),
    ...claimFields,
  };
}

/**
 * Traverse Memgraph for active claims matching query topics and map them
 * to passage candidates for 3-way RRF fusion.
 */
export async function searchGraphClaims(
  db: Kysely<DB>,
  query: string,
  limit?: number | null,
): Promise<JsonObject[]> {
  const maxResults = limit || settings.graphRetrievalLimit;
  const [topicSlugs, searchTerms] = extractQuerySeedTopics(query);
  if (topicSlugs.length === 0 && searchTerms.length === 0) return [];

  let claimRows: Record<string, unknown>[];
  try {
    claimRows = await searchGraphByTopics({ topicSlugs, searchTerms, limit: maxResults });
  } catch (error) {
    // Memgraph down degrades retrieval to two engines; it must not fail /ask.
    console.debug(`Graph traversal unavailable for query ${JSON.stringify(query)}: ${error}`);
    return [];
  }

  const results: JsonObject[] = [];
  for (const row of claimRows) {
    results.push(await toCandidate(db, row));
  }
  return results;
}
