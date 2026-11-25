/** Unit tests for Phase 0 ontology and deterministic topic/author normalization. */

import { expect, test } from "bun:test";
import {
  EDGE_TYPES,
  NODE_LABELS,
  normalizeAuthor,
  normalizeTopic,
  normalizeTopics,
} from "../../kb/graph/ontology";
import { RawExtractedClaim } from "../../kb/schemas/entities";
import { claimId } from "../../kb/schemas/ids";

test("locked ontology has five node labels and five edge types", () => {
  expect(new Set(NODE_LABELS)).toEqual(
    new Set(["Publication", "Author", "Article", "Claim", "Topic"]),
  );
  expect(new Set(EDGE_TYPES)).toEqual(
    new Set(["PUBLISHED_IN", "WRITTEN_BY", "ASSERTS", "ABOUT", "SUPERSEDES"]),
  );
});

test("RAG synonyms collapse to a single canonical topic", () => {
  const variants = [
    "RAG",
    "rag",
    "Retrieval-Augmented Generation",
    "retrieval augmented generation",
    "  Retrieval-Augmented Generation! ",
  ];
  for (const variant of variants) {
    expect(normalizeTopic(variant)).toEqual({ slug: "rag", name: "RAG" });
  }
});

test("core domain aliases resolve deterministically", () => {
  expect(normalizeTopic("Reciprocal Rank Fusion")?.slug).toBe("reciprocal-rank-fusion");
  expect(normalizeTopic("RRF")?.slug).toBe("reciprocal-rank-fusion");
  expect(normalizeTopic("Large Language Models")?.slug).toBe("llm");
  expect(normalizeTopic("LLMs")?.slug).toBe("llm");
  expect(normalizeTopic("Model Context Protocol")?.slug).toBe("mcp");
  expect(normalizeTopic("mcp")?.slug).toBe("mcp");
});

test("depluralization collapses plural technical nouns", () => {
  expect(normalizeTopic("embedding model")?.slug).toBe("embedding-model");
  expect(normalizeTopic("Embedding Models")?.slug).toBe("embedding-model");
  expect(normalizeTopic("vector stores")?.slug).toBe("vector-store");
  expect(normalizeTopic("vector databases")?.slug).toBe("vector-databases"); // "-ses" is kept
  expect(normalizeTopic("Postgres")?.slug).toBe("postgres");
});

test("display names keep acronyms upper case", () => {
  expect(normalizeTopic("sql api")).toEqual({ slug: "sql-api", name: "SQL API" });
  expect(normalizeTopic("Café Latte")?.slug).toBe("cafe-latte");
});

test("stop topics are rejected", () => {
  const stopWords = [
    "ai",
    "AI",
    "system",
    "Systems",
    "code",
    "article",
    "author",
    "data",
    "model",
    "models",
  ];
  for (const stopWord of stopWords) expect(normalizeTopic(stopWord)).toBeNull();
  expect(normalizeTopic("   ")).toBeNull();
  expect(normalizeTopic("!!")).toBeNull();
});

test("normalizeTopics deduplicates and filters stop topics", () => {
  const raw = ["RAG", "Retrieval-Augmented Generation", "AI", "pgvector", "models", "RRF"];
  expect(normalizeTopics(raw).map((t) => t.slug)).toEqual([
    "rag",
    "pgvector",
    "reciprocal-rank-fusion",
  ]);
});

test("author normalization and fallback", () => {
  expect(normalizeAuthor("Miguel  Otero Pedrido")).toEqual({
    slug: "miguel-otero-pedrido",
    name: "Miguel Otero Pedrido",
  });
  expect(normalizeAuthor(null)).toEqual({ slug: "unknown-author", name: "Unknown Author" });
  expect(normalizeAuthor("???")).toEqual({ slug: "unknown-author", name: "Unknown Author" });
});

test("claim type enum bounds are enforced", () => {
  for (const validType of ["opinion", "measurement", "prediction"] as const) {
    const claim = RawExtractedClaim.parse({
      claim_text: "Conditional HTTP 304 polling finishes in under 15ms.",
      quote_span:
        "When nothing has changed, origins return 304 Not Modified " +
        "and the run finishes in under 15ms.",
      claim_type: validType,
      entities: ["Inngest"],
    });
    expect(claim.claim_type).toBe(validType);
  }

  const invalid = RawExtractedClaim.safeParse({
    claim_text: "Invalid claim type example.",
    quote_span: "Some verbatim quote from an article.",
    claim_type: "speculation",
    entities: ["RAG"],
  });
  expect(invalid.success).toBe(false);
});

test("deterministic claim id is idempotent across whitespace variations", () => {
  const id1 = claimId(
    "00000000-0000-0000-0000-000000000001",
    "hash123",
    "When nothing has changed,   origins return 304.",
    "Origins return 304 when unchanged.",
  );
  const id2 = claimId(
    "00000000-0000-0000-0000-000000000001",
    "hash123",
    "When nothing has changed, origins return 304.",
    "Origins return 304   when unchanged.",
  );
  expect(id1).toBe(id2);
});
