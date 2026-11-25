/**
 * Kysely table types. They mirror `migrations/*.sql` by hand: when a migration
 * changes a table, change its interface here in the same commit.
 *
 * Only one function writes each table ("one writer per table" rule):
 * `add-publication` / `backfill-publication` write `publications` and `jobs`,
 * `ingest-article` writes `articles`/`passages`, the cost-capture middleware
 * writes `costs`, and `POST /ask` writes `snapshots`. Every pipeline write is
 * an upsert (snapshots are append-only); see `kb/db/queries.ts`.
 *
 * Conventions (enforced by `kb/db/session.ts`):
 * - NUMERIC and COUNT(*) (int8) come back as JS numbers, not strings.
 * - JSONB comes back parsed; it goes in as JSON text, built with `toJson()`.
 *   (node-postgres would turn a JS array into a Postgres array literal.)
 * - pgvector goes in and comes back as its text literal `[0.1,0.2,...]`;
 *   build it with `toVector()`.
 */

import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type DefaultTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type DefaultJsonb<T> = ColumnType<T, string | undefined, string>;

export type JsonObject = Record<string, unknown>;

export interface PublicationsTable {
  id: Generated<string>;
  slug: string;
  name: string;
  feed_url: string;
  homepage: string;
  active: Generated<boolean>;
}

export interface ArticlesTable {
  id: Generated<string>;
  canonical_id: string;
  publication_id: string;
  url: string;
  title: string;
  author: string | null;
  published_at: Timestamp;
  content_hash: string;
  text: string;
  status: Generated<string>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface PassagesTable {
  id: Generated<string>;
  article_id: string;
  chunk_index: number;
  text: string;
  embedding: string | null;
  /** Generated column (STORED): `to_tsvector('english', text)`. Never written. */
  tsv: ColumnType<string, never, never>;
  /** Temporal validity: a passage with `valid_to` set is no longer current. */
  valid_from: DefaultTimestamp;
  valid_to: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface CursorsTable {
  publication_id: string;
  etag: string | null;
  last_modified: string | null;
  last_checked_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  poll_count: Generated<number>;
  not_modified_count: Generated<number>;
}

export interface JobsTable {
  event_id: string;
  kind: string;
  status: Generated<string>;
  total: Generated<number>;
  done: Generated<number>;
  /** Lets `GET /jobs/:eventId` count articles without threading a job id through events. */
  publication_id: string | null;
  created_at: DefaultTimestamp;
}

export interface CostsTable {
  id: Generated<string>;
  article_id: string | null;
  model: string;
  input_tokens: Generated<number>;
  output_tokens: Generated<number>;
  est_usd: Generated<number>;
  at: DefaultTimestamp;
}

/**
 * One row per answer from `POST /ask`: what was asked, what was answered, and
 * EVERY candidate passage the retriever surfaced (not only the cited ones), with
 * its rank in each search engine. That is what lets us tell, later, whether a bad
 * answer came from ingestion, retrieval or generation.
 */
export interface SnapshotsTable {
  snapshot_id: string;
  question: string;
  answer_text: string;
  citations: DefaultJsonb<JsonObject[]>;
  retrieved: DefaultJsonb<JsonObject[]>;
  retriever_variant: string;
  as_of: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  confidence: number | null;
  latency_ms: Generated<number>;
  created_at: DefaultTimestamp;
}

/** Execution failures from `inngest/function.failed` system events. */
export interface FailuresTable {
  id: Generated<string>;
  function_id: string;
  run_id: string;
  error: string;
  event_data: ColumnType<JsonObject | null, string | null, string | null>;
  created_at: DefaultTimestamp;
}

/**
 * An attributed assertion extracted from an article, verified against a
 * verbatim quote_span in the article text. Active claims have `valid_to IS NULL`.
 */
export interface ClaimsTable {
  id: Generated<string>;
  article_id: string;
  text: string;
  quote_span: string;
  /** opinion | measurement | prediction */
  claim_type: string;
  entities: DefaultJsonb<Array<Record<string, string>>>;
  confidence: Generated<number>;
  valid_from: DefaultTimestamp;
  valid_to: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  supersedes_id: string | null;
}

/** One row per evaluated snapshot, written by `evaluate-answer`. */
export interface EvalResultsTable {
  id: Generated<string>;
  snapshot_id: string;
  deterministic_passed: boolean;
  checks: DefaultJsonb<Record<string, boolean>>;
  faithfulness_verdict: string;
  faithfulness_critique: string;
  disagreement_verdict: string;
  disagreement_critique: string;
  failure_codes: DefaultJsonb<string[]>;
  composite_score: Generated<number>;
  created_at: DefaultTimestamp;
}

/** One row per benchmark experiment or failure replay run (`run-eval-suite`). */
export interface EvalRunsTable {
  run_id: string;
  suite_name: string;
  variants_summary: DefaultJsonb<JsonObject>;
  case_results: DefaultJsonb<JsonObject[]>;
  created_at: DefaultTimestamp;
}

/** One row per bounded research agent execution, written only by `run-research-agent`. */
export interface ResearchRunsTable {
  research_id: string;
  event_id: string | null;
  question: string;
  status: Generated<string>;
  plan: DefaultJsonb<string[]>;
  hops: DefaultJsonb<JsonObject[]>;
  report_text: string | null;
  citations: DefaultJsonb<JsonObject[]>;
  retrieved: DefaultJsonb<JsonObject[]>;
  eval_summary: DefaultJsonb<JsonObject>;
  confidence: number | null;
  iterations_used: Generated<number>;
  total_cost_usd: Generated<number>;
  latency_ms: Generated<number>;
  created_at: DefaultTimestamp;
  completed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

/** One row per weekly briefing, written only by `generate-weekly-digest`. */
export interface DigestsTable {
  digest_id: Generated<string>;
  window_start: Timestamp;
  window_end: Timestamp;
  title: string;
  summary_markdown: string;
  citations: DefaultJsonb<JsonObject[]>;
  stats: DefaultJsonb<JsonObject>;
  created_at: DefaultTimestamp;
}

export interface DB {
  publications: PublicationsTable;
  articles: ArticlesTable;
  passages: PassagesTable;
  cursors: CursorsTable;
  jobs: JobsTable;
  costs: CostsTable;
  snapshots: SnapshotsTable;
  failures: FailuresTable;
  claims: ClaimsTable;
  eval_results: EvalResultsTable;
  eval_runs: EvalRunsTable;
  research_runs: ResearchRunsTable;
  digests: DigestsTable;
}

export type Publication = Selectable<PublicationsTable>;
export type Article = Selectable<ArticlesTable>;
export type NewArticle = Insertable<ArticlesTable>;
export type Passage = Selectable<PassagesTable>;
export type Cursor = Selectable<CursorsTable>;
export type CursorUpdate = Updateable<CursorsTable>;
export type Job = Selectable<JobsTable>;
export type Snapshot = Selectable<SnapshotsTable>;
export type Claim = Selectable<ClaimsTable>;
export type EvalResult = Selectable<EvalResultsTable>;
export type EvalRun = Selectable<EvalRunsTable>;
export type ResearchRun = Selectable<ResearchRunsTable>;
export type Digest = Selectable<DigestsTable>;
