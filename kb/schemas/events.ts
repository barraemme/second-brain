/**
 * Event names and payloads: the contract between functions.
 *
 * Every event has a name constant and a zod schema. Producers build the
 * payload and send `{ name, data }`; consumers validate with
 * `Schema.parse(event.data)` on the first line of the handler. Payload keys
 * stay snake_case: they are the wire format, shared with the Inngest UI and
 * every stored event.
 */

import { z } from "zod";

export const PUBLICATION_ADDED = "kb/publication.added";
export const ARTICLE_DISCOVERED = "kb/article.discovered";
export const ARTICLE_INGESTED = "kb/article.ingested";
export const ARTICLE_UPDATED = "kb/article.updated";
export const CLAIMS_EXTRACTED = "kb/claims.extracted";
export const ANSWER_PRODUCED = "kb/answer.produced";
export const EVAL_RUN_REQUESTED = "kb/eval.run";
export const ANSWER_EVALUATED = "kb/answer.evaluated";
export const RESEARCH_REQUESTED = "kb/research.requested";
export const RESEARCH_COMPLETED = "kb/research.completed";
export const DIGEST_REQUESTED = "kb/digest.requested";
export const DIGEST_PUBLISHED = "kb/digest.published";

export const DiscoverySource = z.enum(["rss", "backfill", "manual", "poll"]);
export type DiscoverySource = z.infer<typeof DiscoverySource>;

/** ISO-8601 datetime in, Date out. Accepts a Date too, so producers can pass one. */
const DateTime = z.union([z.date(), z.iso.datetime({ offset: true })]).pipe(z.coerce.date());

/** HTTP endpoint -> discovery/backfill. Kicks off ingestion for one publication. */
export const PublicationAdded = z.object({
  feed_url: z.string(),
  name: z.string().nullish(),
});
export type PublicationAdded = z.infer<typeof PublicationAdded>;

/** discovery/backfill/freshness -> ingest. One candidate article to fetch. */
export const ArticleDiscovered = z.object({
  canonical_id: z.string(),
  publication_id: z.uuid(),
  url: z.string(),
  title: z.string(),
  published_at: DateTime,
  via: DiscoverySource,
});
export type ArticleDiscovered = z.infer<typeof ArticleDiscovered>;

/** ingest -> anyone listening. An article's passages are now persisted. */
export const ArticleIngested = z.object({
  canonical_id: z.string(),
  article_id: z.uuid(),
  content_hash: z.string(),
  passage_count: z.number().int(),
});
export type ArticleIngested = z.infer<typeof ArticleIngested>;

/** ingest -> anyone listening. An article's passages were superseded and updated. */
export const ArticleUpdated = ArticleIngested;
export type ArticleUpdated = ArticleIngested;

/** enrich -> downstream listeners / telemetry. Summarizes claim extraction and quote guardrail. */
export const ClaimsExtracted = z.object({
  article_id: z.uuid(),
  canonical_id: z.string(),
  claim_count: z.number().int(),
  dropped_spans: z.number().int(),
});
export type ClaimsExtracted = z.infer<typeof ClaimsExtracted>;

/** POST /ask (fire-and-forget) -> evaluators. Points at a stored snapshot. */
export const AnswerProduced = z.object({
  snapshot_id: z.string(),
  retriever_variant: z.string(),
});
export type AnswerProduced = z.infer<typeof AnswerProduced>;

/** POST /evals/run -> run-eval-suite. Triggers a multi-variant benchmark and failure replay. */
export const EvalRunRequested = z.object({
  suite_name: z.string().default("golden_v1"),
  include_failures_table: z.boolean().default(true),
});
export type EvalRunRequested = z.infer<typeof EvalRunRequested>;

/** evaluate-answer -> downstream telemetry. Summarizes the evaluation of a Snapshot. */
export const AnswerEvaluated = z.object({
  snapshot_id: z.string(),
  composite_score: z.number(),
  deterministic_passed: z.boolean(),
  faithfulness_verdict: z.string(),
  disagreement_verdict: z.string(),
  failure_codes: z.array(z.string()),
});
export type AnswerEvaluated = z.infer<typeof AnswerEvaluated>;

/** POST /research or kb_research -> run-research-agent. Starts a bounded research loop. */
export const ResearchRequested = z.object({
  research_id: z.string(),
  question: z.string(),
  max_iterations: z.number().int().nullish(),
  max_usd: z.number().nullish(),
});
export type ResearchRequested = z.infer<typeof ResearchRequested>;

/** run-research-agent -> downstream telemetry. Summarizes a completed research run. */
export const ResearchCompleted = z.object({
  research_id: z.string(),
  status: z.string(),
  iterations_used: z.number().int(),
  total_cost_usd: z.number(),
  confidence: z.number(),
  failure_codes: z.array(z.string()),
});
export type ResearchCompleted = z.infer<typeof ResearchCompleted>;

/** POST /digests/run -> generate-weekly-digest. Generates a weekly digest on demand. */
export const DigestRequested = z.object({
  lookback_days: z.number().int().default(7),
  publication_slugs: z.array(z.string()).nullish(),
});
export type DigestRequested = z.infer<typeof DigestRequested>;

/** generate-weekly-digest -> downstream telemetry. Summarizes a persisted weekly digest. */
export const DigestPublished = z.object({
  digest_id: z.uuid(),
  window_start: DateTime,
  window_end: DateTime,
  article_count: z.number().int(),
  claim_count: z.number().int(),
  disagreements_count: z.number().int(),
});
export type DigestPublished = z.infer<typeof DigestPublished>;
