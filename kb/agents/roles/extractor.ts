/** Claim extractor agent role configured with the locked ontology schema. */

import { settings } from "../../config";
import { normalizeTopics, TOPIC_ALIASES } from "../../graph/ontology";
import {
  ClaimExtractionBatch,
  type ClaimType,
  type RawExtractedClaim,
} from "../../schemas/entities";
import type { Agent } from "../core";
import { CLAIM_EXTRACTOR_SYSTEM_PROMPT } from "../prompts";

export const claimExtractorAgent: Agent<ClaimExtractionBatch> = {
  name: "claim-extractor",
  role: "Structured Claim & Quote-Span Extractor",
  system_prompt: CLAIM_EXTRACTOR_SYSTEM_PROMPT,
  model: settings.extractionModel,
  output_schema: ClaimExtractionBatch,
  max_tokens: settings.extractionMaxTokens,
};

export interface FormatExtractorPromptOptions {
  title: string;
  author: string | null;
  publicationName: string;
  articleText: string;
}

/** Python's `re.escape`: escape every regex metacharacter in `text`. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/**
 * Canonical names of every `TOPIC_ALIASES` key found as a whole word in `lowerText`. Pure.
 * Shared by the claim and research-query heuristics.
 */
export function matchAliasTopicNames(lowerText: string): string[] {
  const matched: string[] = [];
  for (const [aliasKey, [, canonicalName]] of TOPIC_ALIASES) {
    if (new RegExp(`\\b${escapeRegExp(aliasKey)}\\b`).test(lowerText)) matched.push(canonicalName);
  }
  return matched;
}

/** Format the article metadata and body for `claimExtractorAgent`. */
export function formatExtractorPrompt(options: FormatExtractorPromptOptions): string {
  return (
    `Publication: ${options.publicationName}\n` +
    `Article Title: ${options.title}\n` +
    `Author: ${options.author || "Unknown Author"}\n\n` +
    `Article Text:\n${options.articleText}`
  );
}

function classifyClaimType(lowerSentence: string): ClaimType {
  if (/\b\d+(?:\.\d+)?\s*(?:ms|%|x|seconds|bytes|tokens|usd)\b/.test(lowerSentence)) {
    return "measurement";
  }
  if (/\b(?:will|future|predict|next decade|eventually)\b/.test(lowerSentence)) return "prediction";
  return "opinion";
}

/**
 * Deterministic fallback extractor used only when `OPENAI_API_KEY` is not set.
 *
 * Splits the article into sentences, finds sentences mentioning known domain
 * entities, and uses the exact sentence from `articleText` as `quote_span`
 * so the downstream quote-span guardrail still validates real substrings.
 */
export function heuristicExtractClaims(
  articleText: string,
  { maxClaims = 5 }: { maxClaims?: number } = {},
): ClaimExtractionBatch {
  if (maxClaims < 0) throw new Error(`heuristicExtractClaims: negative maxClaims ${maxClaims}`);
  const sentences = articleText
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 25);
  const extracted: RawExtractedClaim[] = [];

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    const topics = normalizeTopics(matchAliasTopicNames(lower));
    if (topics.length === 0) continue;
    extracted.push({
      claim_text: sentence,
      quote_span: sentence,
      claim_type: classifyClaimType(lower),
      entities: topics.slice(0, 5).map((t) => t.name),
      confidence: 0.85,
    });
    if (extracted.length >= maxClaims) break;
  }

  return ClaimExtractionBatch.parse({ claims: extracted });
}
