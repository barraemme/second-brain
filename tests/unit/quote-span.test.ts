/** Unit tests for the deterministic quote-span guardrail (`kb/sources/quote-validator.ts`). */

import { expect, test } from "bun:test";
import { RawExtractedClaim } from "../../kb/schemas/entities";
import { isVerbatimQuote, validateAndNormalizeClaims } from "../../kb/sources/quote-validator";

const SAMPLE_ARTICLE =
  "In production AI systems, Reciprocal Rank Fusion combines BM25 lexical search " +
  "and pgvector cosine similarity without requiring score calibration.\n\n" +
  "When nothing has changed, origins return 304 Not Modified with 0 body bytes, " +
  "and the polling run finishes in under 15ms. However, flat passage retrieval " +
  "cannot answer relational questions across multiple newsletters.";

test("exact verbatim substring passes", () => {
  const quote =
    "Reciprocal Rank Fusion combines BM25 lexical search and pgvector cosine " +
    "similarity without requiring score calibration.";
  expect(isVerbatimQuote(SAMPLE_ARTICLE, quote)).toBe(true);
});

test("whitespace-normalized multiline substring passes", () => {
  const quote =
    "When nothing has changed,   origins return 304 Not Modified\n" +
    "with 0 body bytes, and the polling run finishes in under 15ms.";
  expect(isVerbatimQuote(SAMPLE_ARTICLE, quote)).toBe(true);
});

test("paraphrased or fabricated quote is rejected", () => {
  const paraphrased =
    "Reciprocal Rank Fusion merges BM25 and pgvector scores without needing calibration.";
  const fabricated = "Agentic RAG always requires a cross-encoder reranker in production.";
  const ellipsisTruncated =
    "Reciprocal Rank Fusion combines BM25 ... without requiring score calibration.";
  expect(isVerbatimQuote(SAMPLE_ARTICLE, paraphrased)).toBe(false);
  expect(isVerbatimQuote(SAMPLE_ARTICLE, fabricated)).toBe(false);
  expect(isVerbatimQuote(SAMPLE_ARTICLE, ellipsisTruncated)).toBe(false);
});

test("too short or empty quote span is rejected", () => {
  expect(isVerbatimQuote(SAMPLE_ARTICLE, "")).toBe(false);
  expect(isVerbatimQuote(SAMPLE_ARTICLE, "in under 15ms")).toBe(false);
});

test("validateAndNormalizeClaims keeps valid claims and counts dropped ones", () => {
  const aid = "00000000-0000-0000-0000-000000000099";
  const rawClaims = [
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
      claim_text: "Conditional HTTP 304 polling finishes in under 15ms.",
      quote_span:
        "When nothing has changed, origins return 304 Not Modified with 0 body " +
        "bytes, and the polling run finishes in under 15ms.",
      claim_type: "measurement",
      entities: ["HTTP 304", "AI"],
      confidence: 0.92,
    },
    // Paraphrased / non-verbatim quote -> must be dropped
    {
      claim_text: "Hallucinated paraphrase that alters words from the text.",
      quote_span: "Origins return 304 and finish in less than 15 milliseconds.",
      claim_type: "measurement",
      entities: ["Inngest"],
      confidence: 0.8,
    },
    // Only stop-topics and no fallback -> must be dropped
    {
      claim_text: "Flat passage retrieval cannot answer relational questions.",
      quote_span:
        "However, flat passage retrieval cannot answer relational " +
        "questions across multiple newsletters.",
      claim_type: "opinion",
      entities: ["AI", "system", "models"],
      confidence: 0.85,
    },
  ].map((claim) => RawExtractedClaim.parse(claim));

  const [validated, dropped] = validateAndNormalizeClaims(
    aid,
    "sha256_abc",
    SAMPLE_ARTICLE,
    rawClaims,
  );

  expect(validated).toHaveLength(2);
  expect(dropped).toBe(2);
  expect(validated[0]?.claim_type).toBe("opinion");
  expect(validated[0]?.topics.map((t) => t.slug)).toEqual([
    "reciprocal-rank-fusion",
    "bm25",
    "pgvector",
  ]);
  expect(validated[1]?.claim_type).toBe("measurement");
  expect(validated[1]?.topics.map((t) => t.slug)).toEqual(["http-304"]);
});

test("fallback topic rescues a claim whose entities are all stop topics", () => {
  const raw = RawExtractedClaim.parse({
    claim_text: "Flat passage retrieval cannot answer relational questions.",
    quote_span: "flat passage retrieval cannot answer relational questions",
    claim_type: "opinion",
    entities: ["AI"],
  });
  const [validated, dropped] = validateAndNormalizeClaims("a1", "h1", SAMPLE_ARTICLE, [raw], {
    fallbackTopic: "The Neural Maze",
  });
  expect(dropped).toBe(0);
  expect(validated[0]?.topics).toEqual([{ slug: "the-neural-maze", name: "The Neural Maze" }]);
});
