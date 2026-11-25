/**
 * Domain and extraction schemas for claim extraction and graph ontology.
 *
 * Strict zod schemas sit at the boundary between the LLM extractor, the
 * deterministic quote-span guardrail, and the Postgres/Memgraph writers.
 */

import { z } from "zod";

export const CLAIM_TYPES = ["opinion", "measurement", "prediction"] as const;
export const ClaimType = z.enum(CLAIM_TYPES);
export type ClaimType = z.infer<typeof ClaimType>;
export const VALID_CLAIM_TYPES: ReadonlySet<string> = new Set(CLAIM_TYPES);

export const ExtractedTopic = z.object({
  slug: z.string().describe("Normalized lowercase hyphenated topic slug"),
  name: z.string().describe("Canonical human-readable topic or entity name"),
});
export type ExtractedTopic = z.infer<typeof ExtractedTopic>;

export const RawExtractedClaim = z.object({
  claim_text: z
    .string()
    .min(5)
    .describe("Concise, self-contained assertion attributed to the author"),
  quote_span: z.string().describe("Exact verbatim substring from the article supporting the claim"),
  claim_type: ClaimType,
  entities: z.array(z.string()).min(1).max(5).describe("1 to 5 key technical entities/topics"),
  confidence: z.number().min(0).max(1).default(0.9),
});
export type RawExtractedClaim = z.infer<typeof RawExtractedClaim>;

export const ClaimExtractionBatch = z.object({
  claims: z.array(RawExtractedClaim).default([]),
});
export type ClaimExtractionBatch = z.infer<typeof ClaimExtractionBatch>;

/** A claim that has passed the verbatim quote_span guardrail and topic canonicalization. */
export const ValidatedClaim = z.object({
  claim_id: z.string(),
  article_id: z.string(),
  text: z.string(),
  quote_span: z.string(),
  claim_type: ClaimType,
  confidence: z.number().min(0).max(1).default(0.9),
  topics: z.array(ExtractedTopic).min(1),
});
export type ValidatedClaim = z.infer<typeof ValidatedClaim>;
