/**
 * The First Free Guardrail: deterministic verbatim quote-span verification.
 *
 * Before any LLM-extracted claim touches PostgreSQL or Memgraph, this module
 * verifies that `quote_span` is a real verbatim substring of `articleText`
 * (modulo consecutive whitespace normalization) and canonicalizes its topics.
 * Any fabricated, paraphrased, or truncated quote span is dropped immediately.
 */

import { normalizeTopic, normalizeTopics } from "../graph/ontology";
import type { ExtractedTopic, RawExtractedClaim, ValidatedClaim } from "../schemas/entities";
import { claimId } from "../schemas/ids";

export const MIN_QUOTE_SPAN_CHARS = 15;

/**
 * Collapse consecutive whitespace into a single space while preserving
 * exact words, casing, and punctuation.
 */
export function normalizeWhitespace(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/**
 * True iff `quoteSpan` is at least `minChars` long and appears verbatim
 * inside `articleText` after normalizing consecutive whitespace.
 */
export function isVerbatimQuote(
  articleText: string,
  quoteSpan: string,
  options: { minChars?: number } = {},
): boolean {
  if (!articleText || !quoteSpan) return false;
  const normQuote = normalizeWhitespace(quoteSpan);
  if (normQuote.length < (options.minChars ?? MIN_QUOTE_SPAN_CHARS)) return false;
  return normalizeWhitespace(articleText).includes(normQuote);
}

function claimTopics(raw: RawExtractedClaim, fallbackTopic: string | null): ExtractedTopic[] {
  const topics = normalizeTopics(raw.entities);
  if (topics.length > 0 || !fallbackTopic) return topics;
  const fallback = normalizeTopic(fallbackTopic);
  return fallback === null ? [] : [fallback];
}

/**
 * Validate quote spans and canonicalize topics for a batch of raw LLM claims.
 *
 * Returns `[validatedClaims, droppedSpans]`.
 */
export function validateAndNormalizeClaims(
  articleId: string,
  contentHash: string,
  articleText: string,
  rawClaims: readonly RawExtractedClaim[],
  options: { fallbackTopic?: string | null } = {},
): [ValidatedClaim[], number] {
  const validated: ValidatedClaim[] = [];
  const seenClaimIds = new Set<string>();
  let droppedSpans = 0;

  for (const raw of rawClaims) {
    const topics = isVerbatimQuote(articleText, raw.quote_span)
      ? claimTopics(raw, options.fallbackTopic ?? null)
      : [];
    if (topics.length === 0) {
      droppedSpans += 1;
      continue;
    }

    const normQuote = normalizeWhitespace(raw.quote_span);
    const normClaimText = normalizeWhitespace(raw.claim_text);
    const cid = claimId(articleId, contentHash, normQuote, normClaimText);
    if (seenClaimIds.has(cid)) continue;
    seenClaimIds.add(cid);

    validated.push({
      claim_id: cid,
      article_id: articleId,
      text: normClaimText,
      quote_span: normQuote,
      claim_type: raw.claim_type,
      confidence: raw.confidence,
      topics,
    });
  }

  return [validated, droppedSpans];
}
