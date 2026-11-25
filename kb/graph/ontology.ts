/**
 * Phase 0: Locked Graph Ontology & Entity/Topic Canonicalization.
 *
 * The ontology is strictly closed:
 * - 5 Node Labels: Publication, Author, Article, Claim, Topic
 * - 5 Edge Types: PUBLISHED_IN, WRITTEN_BY, ASSERTS, ABOUT, SUPERSEDES
 *
 * All topic and author strings are deterministically canonicalized here before
 * any node is merged into Memgraph or persisted to Postgres.
 */

import { z } from "zod";
import { ClaimType, type ExtractedTopic } from "../schemas/entities";

export const NODE_LABELS: ReadonlySet<string> = new Set([
  "Publication",
  "Author",
  "Article",
  "Claim",
  "Topic",
]);

export const EDGE_TYPES: ReadonlySet<string> = new Set([
  "PUBLISHED_IN",
  "WRITTEN_BY",
  "ASSERTS",
  "ABOUT",
  "SUPERSEDES",
]);

export const PublicationNode = z.object({
  slug: z.string(),
  name: z.string(),
  homepage: z.string(),
});
export type PublicationNode = z.infer<typeof PublicationNode>;

export const AuthorNode = z.object({ slug: z.string(), name: z.string() });
export type AuthorNode = z.infer<typeof AuthorNode>;

export const ArticleNode = z.object({
  canonical_id: z.string(),
  article_id: z.string(),
  url: z.string(),
  title: z.string(),
  published_at: z.string(),
  content_hash: z.string(),
});
export type ArticleNode = z.infer<typeof ArticleNode>;

export const ClaimNode = z.object({
  claim_id: z.string(),
  article_id: z.string(),
  text: z.string(),
  quote_span: z.string(),
  claim_type: ClaimType,
  confidence: z.number().min(0).max(1),
  valid_from: z.string(),
  valid_to: z.string().nullable().default(null),
});
export type ClaimNode = z.infer<typeof ClaimNode>;

export const TopicNode = z.object({ slug: z.string(), name: z.string() });
export type TopicNode = z.infer<typeof TopicNode>;

const RAG = ["rag", "RAG"] as const;
const AGENTIC_RAG = ["agentic-rag", "Agentic RAG"] as const;
const RRF = ["reciprocal-rank-fusion", "Reciprocal Rank Fusion"] as const;
const LLM = ["llm", "LLM"] as const;
const SLM = ["small-language-model", "Small Language Model"] as const;
const MCP = ["mcp", "Model Context Protocol (MCP)"] as const;
const PGVECTOR = ["pgvector", "pgvector"] as const;
const BM25 = ["bm25", "BM25"] as const;
const HYBRID = ["hybrid-retrieval", "Hybrid Retrieval"] as const;
const RERANKER = ["reranker", "Reranker"] as const;
const TTC = ["test-time-compute", "Test-Time Compute"] as const;
const DURABLE = ["durable-execution", "Durable Execution"] as const;

/**
 * Controlled vocabulary alias map for core AI engineering entities across publications.
 * Keys may be raw lowercase strings or hyphen-normalized slugs. Values are `[slug, name]`.
 */
export const TOPIC_ALIASES: ReadonlyMap<string, readonly [string, string]> = new Map<
  string,
  readonly [string, string]
>([
  // RAG
  ["rag", RAG],
  ["retrieval augmented generation", RAG],
  ["retrieval-augmented generation", RAG],
  ["retrieval-augmented-generation", RAG],
  // Agentic RAG
  ["agentic rag", AGENTIC_RAG],
  ["agentic-rag", AGENTIC_RAG],
  // RRF
  ["rrf", RRF],
  ["reciprocal rank fusion", RRF],
  ["reciprocal-rank-fusion", RRF],
  // LLM
  ["llm", LLM],
  ["llms", LLM],
  ["large language model", LLM],
  ["large language models", LLM],
  ["large-language-model", LLM],
  ["large-language-models", LLM],
  // SLM
  ["slm", SLM],
  ["slms", SLM],
  ["small language model", SLM],
  ["small language models", SLM],
  ["small-language-model", SLM],
  ["small-language-models", SLM],
  // MCP
  ["mcp", MCP],
  ["model context protocol", MCP],
  ["model-context-protocol", MCP],
  // Storage & Orchestration
  ["pgvector", PGVECTOR],
  ["pg-vector", PGVECTOR],
  ["inngest", ["inngest", "Inngest"]],
  ["memgraph", ["memgraph", "Memgraph"]],
  ["bm25", BM25],
  ["bm-25", BM25],
  // Retrieval & Reranking
  ["hybrid search", HYBRID],
  ["hybrid-search", HYBRID],
  ["hybrid retrieval", HYBRID],
  ["hybrid-retrieval", HYBRID],
  ["reranker", RERANKER],
  ["rerankers", RERANKER],
  ["reranking", RERANKER],
  ["re-ranker", RERANKER],
  ["re-ranking", RERANKER],
  // Compute & Orchestration concepts
  ["test time compute", TTC],
  ["test-time compute", TTC],
  ["test-time-compute", TTC],
  ["inference-time-compute", TTC],
  ["durable execution", DURABLE],
  ["durable-execution", DURABLE],
]);

/** Overly generic terms rejected so Topic nodes never become high-degree supernode hairballs. */
export const STOP_TOPICS: ReadonlySet<string> = new Set([
  "ai",
  "system",
  "systems",
  "code",
  "article",
  "articles",
  "author",
  "authors",
  "data",
  "model",
  "models",
  "software",
  "tool",
  "tools",
  "technology",
  "thing",
  "things",
  "method",
  "methods",
  "approach",
  "approaches",
  "use",
  "way",
]);

const SINGULAR_EXCEPTIONS: ReadonlySet<string> = new Set([
  "postgres",
  "redis",
  "serverless",
  "analytics",
  "metrics",
  "mathematics",
  "physics",
  "statistics",
  "ethics",
  "semantics",
  "heuristics",
  "logistics",
  "dynamics",
  "corpus",
  "status",
  "bias",
  "pass",
  "class",
]);

const ACRONYMS: ReadonlySet<string> = new Set([
  "rag",
  "llm",
  "mcp",
  "rrf",
  "bm25",
  "sql",
  "api",
  "gpu",
  "cpu",
]);

// Python's str.strip(".,;:!?'\"()[]{}").
const EDGE_PUNCTUATION = /^[.,;:!?'"()[\]{}]+|[.,;:!?'"()[\]{}]+$/g;

const endsWithAny = (token: string, suffixes: readonly string[]): boolean =>
  suffixes.some((suffix) => token.endsWith(suffix));

/** De-pluralize simple trailing 's' on technical nouns where safe. */
function depluralizeToken(token: string): string {
  if (token.length <= 3 || SINGULAR_EXCEPTIONS.has(token)) return token;
  if (endsWithAny(token, ["ss", "us", "is", "as", "os", "ics"])) return token;
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("s") && !token.endsWith("es")) return token.slice(0, -1);
  const keepsEs = endsWithAny(token, ["ses", "xes", "zes", "ches", "shes"]);
  if (token.endsWith("es") && token.length > 4 && !keepsEs) return token.slice(0, -1);
  return token;
}

/** Collapse runs of whitespace to one space and trim (Python's `" ".join(s.split())`). */
function collapseSpaces(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

/** Normalize Unicode, lowercase, and collapse non-alphanumeric runs to single hyphens. */
export function slugify(raw: string): string {
  // NFKD splits accented letters into base + combining mark; dropping non-ASCII keeps the base.
  const asciiText = raw.normalize("NFKD").replace(/[\u0080-\uffff]/g, "");
  return asciiText
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Deterministically normalize an author byline into an AuthorNode. */
export function normalizeAuthor(raw: string | null | undefined): AuthorNode {
  const unknown: AuthorNode = { slug: "unknown-author", name: "Unknown Author" };
  if (!raw?.trim()) return unknown;
  const cleanedName = collapseSpaces(raw);
  const slug = slugify(cleanedName);
  return slug ? { slug, name: cleanedName } : unknown;
}

function aliasTopic(key: string): ExtractedTopic | null {
  const alias = TOPIC_ALIASES.get(key);
  return alias === undefined ? null : { slug: alias[0], name: alias[1] };
}

function displayName(canonicalSlug: string): string {
  return canonicalSlug
    .split("-")
    .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/** Canonicalize a raw entity/topic string into an ExtractedTopic, or null if rejected. */
export function normalizeTopic(raw: string): ExtractedTopic | null {
  if (!raw?.trim()) return null;

  const cleaned = collapseSpaces(raw.normalize("NFKC"));
  const lowered = cleaned.toLowerCase().replace(EDGE_PUNCTUATION, "");
  if (!lowered) return null;

  const loweredAlias = aliasTopic(lowered);
  if (loweredAlias !== null) return loweredAlias;

  const rawSlug = slugify(lowered);
  if (rawSlug.length < 2) return null;

  const slugAlias = aliasTopic(rawSlug);
  if (slugAlias !== null) return slugAlias;

  if (STOP_TOPICS.has(rawSlug) || STOP_TOPICS.has(lowered)) return null;

  // De-pluralize words in the slug (especially the head noun at the end)
  const parts = rawSlug.split("-");
  parts[parts.length - 1] = depluralizeToken(parts.at(-1) ?? "");
  const canonicalSlug = parts.filter(Boolean).join("-");

  if (canonicalSlug.length < 2) return null;

  const canonicalAlias = aliasTopic(canonicalSlug);
  if (canonicalAlias !== null) return canonicalAlias;

  if (STOP_TOPICS.has(canonicalSlug)) return null;

  return { slug: canonicalSlug, name: displayName(canonicalSlug) };
}

/** Normalize and deduplicate a list of raw topic strings, preserving order. */
export function normalizeTopics(rawEntities: readonly string[]): ExtractedTopic[] {
  const seenSlugs = new Set<string>();
  const topics: ExtractedTopic[] = [];
  for (const raw of rawEntities) {
    const topic = normalizeTopic(raw);
    if (topic === null || seenSlugs.has(topic.slug)) continue;
    seenSlugs.add(topic.slug);
    topics.push(topic);
  }
  return topics;
}
