/**
 * Every SQL statement in the project lives here. Functions and HTTP endpoints
 * call these helpers; they never build SQL themselves.
 */

import { type Kysely, sql } from "kysely";
import type { ValidatedClaim } from "../schemas/entities";
import { toJson, toVector } from "./session";
import type { Article, Claim, Cursor, DB, Job, JsonObject, Publication, Snapshot } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, name: string): void {
  if (!UUID_RE.test(value)) throw new Error(`${name} is not a UUID: ${JSON.stringify(value)}`);
}

function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** Python's `round(x, 4)`. Pure. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

// ---------------------------------------------------------------- publications

export async function upsertPublication(
  db: Kysely<DB>,
  options: { slug: string; name: string; feedUrl: string; homepage: string },
): Promise<string> {
  const { slug, name, feedUrl, homepage } = options;
  const row = await db
    .insertInto("publications")
    .values({ slug, name, feed_url: feedUrl, homepage })
    .onConflict((oc) => oc.column("slug").doUpdateSet({ name, feed_url: feedUrl, homepage }))
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function getPublicationBySlug(
  db: Kysely<DB>,
  slug: string,
): Promise<Publication | null> {
  const row = await db
    .selectFrom("publications")
    .selectAll()
    .where("slug", "=", slug)
    .executeTakeFirst();
  return row ?? null;
}

/** Which of these articles are already stored? */
export async function getExistingCanonicalIds(
  db: Kysely<DB>,
  canonicalIds: readonly string[],
): Promise<Set<string>> {
  if (canonicalIds.length === 0) return new Set();
  const rows = await db
    .selectFrom("articles")
    .select("canonical_id")
    .where("canonical_id", "in", canonicalIds)
    .execute();
  return new Set(rows.map((row) => row.canonical_id));
}

export async function listPublications(db: Kysely<DB>): Promise<Publication[]> {
  return db.selectFrom("publications").selectAll().execute();
}

// -------------------------------------------------------------------- articles

/** Upsert by `canonical_id`: the dedupe key across every ingestion path. */
export async function upsertArticle(
  db: Kysely<DB>,
  options: {
    canonicalId: string;
    publicationId: string;
    url: string;
    title: string;
    author: string | null;
    publishedAt: Date;
    contentHash: string;
    text: string;
  },
): Promise<string> {
  const { canonicalId, publicationId, url, title, author, publishedAt, contentHash, text } =
    options;
  const updated = { title, author, published_at: publishedAt, content_hash: contentHash, text };
  const row = await db
    .insertInto("articles")
    .values({ ...updated, canonical_id: canonicalId, publication_id: publicationId, url })
    .onConflict((oc) =>
      oc.column("canonical_id").doUpdateSet({ ...updated, updated_at: sql<Date>`now()` }),
    )
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

export interface PassageInput {
  chunk_index: number;
  text: string;
  embedding: readonly number[] | null;
}

function passageRows(articleId: string, passages: readonly PassageInput[]) {
  return passages.map((p) => ({
    article_id: articleId,
    chunk_index: p.chunk_index,
    text: p.text,
    embedding: p.embedding === null ? null : sql<string>`${toVector(p.embedding)}::vector`,
  }));
}

/**
 * Upsert by `(article_id, chunk_index)`: re-running produces zero new rows.
 *
 * `tsv` is a generated column (see the migration) and is never written here.
 */
export async function replacePassages(
  db: Kysely<DB>,
  options: { articleId: string; passages: readonly PassageInput[] },
): Promise<number> {
  const { articleId, passages } = options;
  if (passages.length === 0) return 0;
  await db
    .insertInto("passages")
    .values(passageRows(articleId, passages))
    .onConflict((oc) =>
      oc
        .columns(["article_id", "chunk_index"])
        .where("valid_to", "is", null)
        .doUpdateSet((eb) => ({
          text: eb.ref("excluded.text"),
          embedding: eb.ref("excluded.embedding"),
        })),
    )
    .execute();
  return passages.length;
}

/** Close active passages by setting valid_to = now(). History is preserved. */
export async function supersedePassages(db: Kysely<DB>, articleId: string): Promise<number> {
  const result = await db
    .updateTable("passages")
    .set({ valid_to: sql<Date>`now()` })
    .where("article_id", "=", articleId)
    .where("valid_to", "is", null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

/** Insert new passage versions without conflicting on previously superseded rows. */
export async function insertPassagesFresh(
  db: Kysely<DB>,
  options: { articleId: string; passages: readonly PassageInput[] },
): Promise<number> {
  const { articleId, passages } = options;
  if (passages.length === 0) return 0;
  await db.insertInto("passages").values(passageRows(articleId, passages)).execute();
  return passages.length;
}

export async function getArticleByCanonicalId(
  db: Kysely<DB>,
  canonicalId: string,
): Promise<Article | null> {
  const row = await db
    .selectFrom("articles")
    .selectAll()
    .where("canonical_id", "=", canonicalId)
    .executeTakeFirst();
  return row ?? null;
}

/** Fetch an Article alongside its parent Publication. */
export async function getArticleWithPublication(
  db: Kysely<DB>,
  articleId: string,
): Promise<[Article, Publication] | null> {
  assertUuid(articleId, "articleId");
  const article = await db
    .selectFrom("articles")
    .selectAll()
    .where("id", "=", articleId)
    .executeTakeFirst();
  if (article === undefined) return null;
  const publication = await db
    .selectFrom("publications")
    .selectAll()
    .where("id", "=", article.publication_id)
    .executeTakeFirst();
  return publication === undefined ? null : [article, publication];
}

// ------------------------------------------------------------------------ jobs

export async function createJob(
  db: Kysely<DB>,
  options: { eventId: string; kind: string; total: number; publicationId?: string | null },
): Promise<void> {
  await db
    .insertInto("jobs")
    .values({
      event_id: options.eventId,
      kind: options.kind,
      status: "running",
      total: options.total,
      done: 0,
      publication_id: options.publicationId ?? null,
    })
    .onConflict((oc) => oc.column("event_id").doNothing())
    .execute();
}

export async function getJob(db: Kysely<DB>, eventId: string): Promise<Job | null> {
  const row = await db
    .selectFrom("jobs")
    .selectAll()
    .where("event_id", "=", eventId)
    .executeTakeFirst();
  return row ?? null;
}

/**
 * `done` is resolved from real article rows, not incremented by ingest-article
 * (which never learns which discovery job triggered it; see the `jobs.publication_id`
 * comment). Read-repairs `jobs.done` and `jobs.status` in the same transaction.
 *
 * Only articles written since the job started count towards it: a backfill of a
 * publication that already has articles must not look finished before it starts.
 */
export async function getJobStatus(
  db: Kysely<DB>,
  eventId: string,
): Promise<Record<string, unknown> | null> {
  const job = await getJob(db, eventId);
  if (job === null) return null;
  const counted =
    job.publication_id === null
      ? job.total
      : Math.min(
          await countArticlesForPublicationSince(db, job.publication_id, job.created_at),
          job.total,
        );
  const done = Math.max(counted, job.done);
  const status = done >= job.total ? "completed" : job.status;
  if (done !== job.done || status !== job.status) {
    await db.updateTable("jobs").set({ done, status }).where("event_id", "=", eventId).execute();
  }
  return { event_id: job.event_id, kind: job.kind, status, total: job.total, done };
}

// ---------------------------------------------------------------------- counts

export async function countArticles(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom("articles")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return row.count;
}

export async function countPassages(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom("passages")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return row.count;
}

export async function countArticlesForPublication(
  db: Kysely<DB>,
  publicationId: string,
): Promise<number> {
  const row = await db
    .selectFrom("articles")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("publication_id", "=", publicationId)
    .executeTakeFirstOrThrow();
  return row.count;
}

/** Articles of a publication created or updated at or after `since`. */
export async function countArticlesForPublicationSince(
  db: Kysely<DB>,
  publicationId: string,
  since: Date,
): Promise<number> {
  const row = await db
    .selectFrom("articles")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("publication_id", "=", publicationId)
    .where("updated_at", ">=", since)
    .executeTakeFirstOrThrow();
  return row.count;
}

/** Count active claims (`valid_to IS NULL`) in Postgres. */
export async function countActiveClaims(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom("claims")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("valid_to", "is", null)
    .executeTakeFirstOrThrow();
  return row.count;
}

// ----------------------------------------------------------------------- costs

export async function insertCost(
  db: Kysely<DB>,
  options: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    estUsd: number;
    articleId?: string | null;
  },
): Promise<void> {
  await db
    .insertInto("costs")
    .values({
      article_id: options.articleId ?? null,
      model: options.model,
      input_tokens: options.inputTokens,
      output_tokens: options.outputTokens,
      est_usd: options.estUsd,
    })
    .execute();
}

// ------------------------------------------------------------------- retrieval

/**
 * BM25 (tsvector) search, no LLM. Sparse half of retrieval
 * (`kb/retrieval/sparse.ts`); fused with the dense half.
 */
export async function searchPassagesBm25(
  db: Kysely<DB>,
  query: string,
  limit: number,
): Promise<JsonObject[]> {
  const tsquery = sql`websearch_to_tsquery('english', ${query})`;
  const rank = sql<number>`ts_rank(passages.tsv, ${tsquery})`;
  const rows = await db
    .selectFrom("passages")
    .innerJoin("articles", "articles.id", "passages.article_id")
    .select([
      "passages.id",
      "passages.text",
      "articles.title",
      "articles.author",
      "articles.url",
      "articles.published_at",
      rank.as("rank"),
    ])
    .where(sql<boolean>`passages.tsv @@ ${tsquery}`)
    .where("passages.valid_to", "is", null)
    .orderBy(rank, "desc")
    .limit(limit)
    .execute();
  return rows.map((row) => ({
    passage_id: row.id,
    text: row.text,
    title: row.title,
    author: row.author,
    url: row.url,
    published_at: row.published_at.toISOString(),
    rank: Number(row.rank),
  }));
}

/**
 * Cosine-similarity search over `passages.embedding` (pgvector), no LLM.
 * Dense half of retrieval (`kb/retrieval/dense.ts`); fused with the sparse half.
 */
export async function searchPassagesDense(
  db: Kysely<DB>,
  queryEmbedding: readonly number[],
  limit: number,
): Promise<JsonObject[]> {
  const distance = sql<number>`passages.embedding <=> ${toVector(queryEmbedding)}::vector`;
  const rows = await db
    .selectFrom("passages")
    .innerJoin("articles", "articles.id", "passages.article_id")
    .select([
      "passages.id",
      "passages.text",
      "articles.title",
      "articles.author",
      "articles.url",
      "articles.published_at",
      distance.as("distance"),
    ])
    .where("passages.valid_to", "is", null)
    .where("passages.embedding", "is not", null)
    .orderBy(distance, "asc")
    .limit(limit)
    .execute();
  return rows.map((row) => ({
    passage_id: row.id,
    text: row.text,
    title: row.title,
    author: row.author,
    url: row.url,
    published_at: row.published_at.toISOString(),
    // Cosine similarity, not distance: higher is more relevant, consistent
    // with searchPassagesBm25's `rank` so callers don't special-case sign.
    rank: 1.0 - Number(row.distance),
  }));
}

// ------------------------------------------------------------------- snapshots

export async function saveSnapshot(
  db: Kysely<DB>,
  options: {
    snapshotId: string;
    question: string;
    answerText: string;
    citations: readonly JsonObject[];
    retrieved: readonly JsonObject[];
    retrieverVariant: string;
    asOf: Date | null;
    latencyMs: number;
  },
): Promise<void> {
  await db
    .insertInto("snapshots")
    .values({
      snapshot_id: options.snapshotId,
      question: options.question,
      answer_text: options.answerText,
      citations: toJson(options.citations),
      retrieved: toJson(options.retrieved),
      retriever_variant: options.retrieverVariant,
      as_of: options.asOf,
      latency_ms: options.latencyMs,
    })
    .execute();
}

export async function getSnapshot(db: Kysely<DB>, snapshotId: string): Promise<Snapshot | null> {
  const row = await db
    .selectFrom("snapshots")
    .selectAll()
    .where("snapshot_id", "=", snapshotId)
    .executeTakeFirst();
  return row ?? null;
}

// --------------------------------------------------------------------- cursors

export async function getCursor(db: Kysely<DB>, publicationId: string): Promise<Cursor | null> {
  const row = await db
    .selectFrom("cursors")
    .selectAll()
    .where("publication_id", "=", publicationId)
    .executeTakeFirst();
  return row ?? null;
}

/** Update or insert publication polling cursor with conditional response metadata. */
export async function updateCursor(
  db: Kysely<DB>,
  options: {
    publicationId: string;
    etag: string | null;
    lastModified: string | null;
    notModified?: boolean;
  },
): Promise<void> {
  const { publicationId, etag, lastModified } = options;
  const notModified = options.notModified ?? false;
  const existing = await getCursor(db, publicationId);
  if (existing === null) {
    await db
      .insertInto("cursors")
      .values({
        publication_id: publicationId,
        etag,
        last_modified: lastModified,
        last_checked_at: new Date(),
        poll_count: 1,
        not_modified_count: notModified ? 1 : 0,
      })
      .execute();
    return;
  }
  // A 304 keeps the stored validators; a 200 replaces only the ones it sent.
  const validators = notModified
    ? {}
    : { etag: etag || existing.etag, last_modified: lastModified || existing.last_modified };
  await db
    .updateTable("cursors")
    .set({
      ...validators,
      poll_count: existing.poll_count + 1,
      not_modified_count: existing.not_modified_count + (notModified ? 1 : 0),
      last_checked_at: new Date(),
    })
    .where("publication_id", "=", publicationId)
    .execute();
}

// -------------------------------------------------------------------- failures

export async function recordFailure(
  db: Kysely<DB>,
  options: {
    functionId: string;
    runId: string;
    error: string;
    eventData?: JsonObject | null;
  },
): Promise<string> {
  const eventData = options.eventData ?? null;
  const row = await db
    .insertInto("failures")
    .values({
      function_id: options.functionId,
      run_id: options.runId,
      error: options.error,
      event_data: eventData === null ? null : toJson(eventData),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Return the most recent rows from the `failures` table for eval replay. */
export async function listRecentFailures(db: Kysely<DB>, limit = 20): Promise<JsonObject[]> {
  const rows = await db
    .selectFrom("failures")
    .selectAll()
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
  return rows.map((f) => ({
    id: f.id,
    function_id: f.function_id,
    run_id: f.run_id,
    error: f.error,
    event_data: f.event_data,
    created_at: f.created_at.toISOString(),
  }));
}

/** List publications alongside article counts and cursor sync info. */
export async function listPublicationsWithStats(db: Kysely<DB>): Promise<JsonObject[]> {
  const pubs = await listPublications(db);
  const results: JsonObject[] = [];
  for (const pub of pubs) {
    const articleCount = await countArticlesForPublication(db, pub.id);
    const cursor = await getCursor(db, pub.id);
    results.push({
      id: pub.id,
      slug: pub.slug,
      name: pub.name,
      feed_url: pub.feed_url,
      homepage: pub.homepage,
      active: pub.active,
      article_count: articleCount,
      last_checked_at: isoOrNull(cursor?.last_checked_at ?? null),
      poll_count: cursor?.poll_count ?? 0,
      not_modified_count: cursor?.not_modified_count ?? 0,
    });
  }
  return results;
}

// ---------------------------------------------------------------------- claims

/** Return all currently active claims for an article. */
export async function getActiveClaimsForArticle(
  db: Kysely<DB>,
  articleId: string,
): Promise<Claim[]> {
  return db
    .selectFrom("claims")
    .selectAll()
    .where("article_id", "=", articleId)
    .where("valid_to", "is", null)
    .execute();
}

/** Topic slug -> most recent superseded claim id. Pure. */
function mapTopicsToOldClaims(staleClaims: readonly Claim[]): Map<string, string> {
  const topicToOldClaimId = new Map<string, string>();
  for (const old of staleClaims) {
    for (const ent of old.entities ?? []) {
      if (ent.slug) topicToOldClaimId.set(ent.slug, old.id);
    }
  }
  return topicToOldClaimId;
}

async function upsertClaim(
  db: Kysely<DB>,
  options: {
    claim: ValidatedClaim;
    articleId: string;
    entities: Array<Record<string, string>>;
    supersedesId: string | null;
    now: Date;
  },
): Promise<void> {
  const { claim, articleId, entities, supersedesId, now } = options;
  const updated = {
    text: claim.text,
    quote_span: claim.quote_span,
    claim_type: claim.claim_type,
    entities: toJson(entities),
    confidence: claim.confidence ?? 0.9,
    valid_to: null,
    supersedes_id: supersedesId,
  };
  await db
    .insertInto("claims")
    .values({ ...updated, id: claim.claim_id, article_id: articleId, valid_from: now })
    .onConflict((oc) => oc.column("id").doUpdateSet(updated))
    .execute();
}

/**
 * Supersede stale active claims for `articleId` and upsert the newly validated
 * claims. Returns `supersedes_pairs` (`[{new_claim_id, old_claim_id, at}]`) so
 * Memgraph can merge `[:SUPERSEDES]` edges for topic-overlapping revisions.
 */
export async function persistArticleClaims(
  db: Kysely<DB>,
  options: { articleId: string; claims: readonly ValidatedClaim[]; now: Date },
): Promise<Array<Record<string, string>>> {
  const { articleId, claims, now } = options;
  const existingActive = await getActiveClaimsForArticle(db, articleId);
  const incomingIds = new Set(claims.map((c) => c.claim_id.toLowerCase()));

  // Any active claim not in the new batch belongs to a prior revision and is superseded
  const staleClaims = existingActive.filter((old) => !incomingIds.has(old.id.toLowerCase()));
  if (staleClaims.length > 0) {
    const staleIds = staleClaims.map((old) => old.id);
    await db.updateTable("claims").set({ valid_to: now }).where("id", "in", staleIds).execute();
  }

  // New claims on the same topic as a superseded one link via supersedes_id / [:SUPERSEDES]
  const topicToOldClaimId = mapTopicsToOldClaims(staleClaims);
  const supersedesPairs: Array<Record<string, string>> = [];
  const nowIso = now.toISOString();

  for (const claim of claims) {
    const cid = claim.claim_id.toLowerCase();
    const entities = claim.topics.map((t) => ({ slug: t.slug, name: t.name }));
    const supersedesId =
      entities.map((ent) => topicToOldClaimId.get(ent.slug)).find((id) => id && id !== cid) ?? null;
    if (supersedesId !== null) {
      supersedesPairs.push({ new_claim_id: cid, old_claim_id: supersedesId, at: nowIso });
    }
    await upsertClaim(db, { claim, articleId, entities, supersedesId, now });
  }
  return supersedesPairs;
}

/**
 * Resolve an active Postgres passage from `articleId` containing `quoteSpan`
 * (falling back to the first active passage of the article if the quote spans a
 * chunk boundary).
 */
export async function findMatchingPassageForQuote(
  db: Kysely<DB>,
  options: { articleId: string; quoteSpan: string },
): Promise<JsonObject | null> {
  const rows = await db
    .selectFrom("passages")
    .innerJoin("articles", "articles.id", "passages.article_id")
    .select([
      "passages.id",
      "passages.text",
      "passages.chunk_index",
      "articles.title",
      "articles.author",
      "articles.url",
      "articles.published_at",
    ])
    .where("passages.article_id", "=", options.articleId)
    .where("passages.valid_to", "is", null)
    .orderBy("passages.chunk_index", "asc")
    .execute();
  const first = rows[0];
  if (first === undefined) return null;

  const normalize = (s: string) => s.split(/\s+/).filter(Boolean).join(" ").toLowerCase();
  const normQuote = normalize(options.quoteSpan);
  const probe = normQuote.slice(0, 60);
  const chosen =
    rows.find((row) => {
      const normPassage = normalize(row.text);
      return normPassage.includes(normQuote) || (probe !== "" && normPassage.includes(probe));
    }) ?? first;

  return {
    passage_id: chosen.id,
    text: chosen.text,
    title: chosen.title,
    author: chosen.author,
    url: chosen.url,
    published_at: chosen.published_at.toISOString(),
  };
}

// ------------------------------------------------------------------ provenance

function provenanceSource(article: Article, pub: Publication): JsonObject {
  return {
    article: {
      article_id: article.id,
      canonical_id: article.canonical_id,
      title: article.title,
      url: article.url,
      published_at: article.published_at.toISOString(),
      content_hash: article.content_hash,
    },
    publication: { slug: pub.slug, name: pub.name, homepage: pub.homepage },
    author: article.author || "Unknown Author",
  };
}

async function getClaimProvenance(db: Kysely<DB>, targetId: string): Promise<JsonObject | null> {
  const claim = await db
    .selectFrom("claims")
    .selectAll()
    .where("id", "=", targetId)
    .executeTakeFirst();
  if (claim === undefined) return null;
  const parent = await getArticleWithPublication(db, claim.article_id);
  if (parent === null) return null;
  return {
    kind: "claim",
    id: claim.id,
    ...provenanceSource(...parent),
    verbatim_quote: claim.quote_span,
    claim_text: claim.text,
    claim_type: claim.claim_type,
    confidence: Number(claim.confidence),
    topics: [...(claim.entities ?? [])],
    validity: {
      valid_from: claim.valid_from.toISOString(),
      valid_to: isoOrNull(claim.valid_to),
      is_active: claim.valid_to === null,
      supersedes_id: claim.supersedes_id,
    },
  };
}

async function getPassageProvenance(db: Kysely<DB>, targetId: string): Promise<JsonObject | null> {
  const passage = await db
    .selectFrom("passages")
    .select(["id", "article_id", "chunk_index", "text", "valid_from", "valid_to"])
    .where("id", "=", targetId)
    .executeTakeFirst();
  if (passage === undefined) return null;
  const parent = await getArticleWithPublication(db, passage.article_id);
  if (parent === null) return null;
  return {
    kind: "passage",
    id: passage.id,
    chunk_index: passage.chunk_index,
    ...provenanceSource(...parent),
    verbatim_quote: passage.text,
    validity: {
      valid_from: passage.valid_from.toISOString(),
      valid_to: isoOrNull(passage.valid_to),
      is_active: passage.valid_to === null,
      supersedes_id: null,
    },
  };
}

/** Look up full lineage for a `claim_id` or `passage_id` for `kb_sources`. */
export async function getSourceProvenance(
  db: Kysely<DB>,
  targetId: string,
): Promise<JsonObject | null> {
  assertUuid(targetId, "targetId");
  return (await getClaimProvenance(db, targetId)) ?? getPassageProvenance(db, targetId);
}

// ----------------------------------------------------------------------- evals

/** Upsert an `eval_results` row for `snapshotId` and update `snapshots.confidence`. */
export async function upsertEvalResult(
  db: Kysely<DB>,
  options: {
    snapshotId: string;
    deterministicPassed: boolean;
    checks: Record<string, boolean>;
    faithfulnessVerdict: string;
    faithfulnessCritique: string;
    disagreementVerdict: string;
    disagreementCritique: string;
    failureCodes: readonly string[];
    compositeScore: number;
  },
): Promise<string> {
  const updated = {
    deterministic_passed: options.deterministicPassed,
    checks: toJson(options.checks),
    faithfulness_verdict: options.faithfulnessVerdict,
    faithfulness_critique: options.faithfulnessCritique,
    disagreement_verdict: options.disagreementVerdict,
    disagreement_critique: options.disagreementCritique,
    failure_codes: toJson(options.failureCodes),
    composite_score: options.compositeScore,
  };
  const row = await db
    .insertInto("eval_results")
    .values({ ...updated, snapshot_id: options.snapshotId })
    .onConflict((oc) => oc.column("snapshot_id").doUpdateSet(updated))
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .updateTable("snapshots")
    .set({ confidence: options.compositeScore })
    .where("snapshot_id", "=", options.snapshotId)
    .execute();
  return row.id;
}

/** Upsert a benchmark or failure-replay suite execution in `eval_runs`. */
export async function upsertEvalRun(
  db: Kysely<DB>,
  options: {
    runId: string;
    suiteName: string;
    variantsSummary: JsonObject;
    caseResults: readonly JsonObject[];
  },
): Promise<string> {
  const updated = {
    suite_name: options.suiteName,
    variants_summary: toJson(options.variantsSummary),
    case_results: toJson(options.caseResults),
  };
  const row = await db
    .insertInto("eval_runs")
    .values({ ...updated, run_id: options.runId })
    .onConflict((oc) => oc.column("run_id").doUpdateSet(updated))
    .returning("run_id")
    .executeTakeFirstOrThrow();
  return row.run_id;
}

/** Assemble the fast-read evaluation report for `GET /evals/latest` and `kb_eval_report`. */
export async function getLatestEvalReport(db: Kysely<DB>, limit = 10): Promise<JsonObject> {
  const latestRun = await db
    .selectFrom("eval_runs")
    .selectAll()
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
  const evalRows = await db
    .selectFrom("eval_results")
    .selectAll()
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
  const total = await db
    .selectFrom("eval_results")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();

  const taxonomyCounts: Record<string, number> = {};
  for (const row of evalRows) {
    for (const code of row.failure_codes ?? []) {
      taxonomyCounts[code] = (taxonomyCounts[code] ?? 0) + 1;
    }
  }
  const detPasses = evalRows.filter((row) => row.deterministic_passed).length;
  const faithPasses = evalRows.filter((row) => row.faithfulness_verdict === "PASS").length;
  const denom = Math.max(evalRows.length, 1);
  const hasRows = evalRows.length > 0;

  return {
    total_evaluated_snapshots: total.count,
    recent_deterministic_pass_rate: hasRows ? round4(detPasses / denom) : null,
    recent_faithfulness_pass_rate: hasRows ? round4(faithPasses / denom) : null,
    failure_taxonomy_counts: taxonomyCounts,
    recent_evaluations: evalRows.map((row) => ({
      snapshot_id: row.snapshot_id,
      composite_score: Number(row.composite_score),
      deterministic_passed: row.deterministic_passed,
      faithfulness_verdict: row.faithfulness_verdict,
      faithfulness_critique: row.faithfulness_critique,
      disagreement_verdict: row.disagreement_verdict,
      failure_codes: [...(row.failure_codes ?? [])],
      created_at: row.created_at.toISOString(),
    })),
    latest_suite_run:
      latestRun === undefined
        ? null
        : {
            run_id: latestRun.run_id,
            suite_name: latestRun.suite_name,
            variants_summary: latestRun.variants_summary,
            created_at: latestRun.created_at.toISOString(),
          },
  };
}

// -------------------------------------------------------------------- research

export interface ResearchRunInput {
  researchId: string;
  eventId: string | null;
  question: string;
  status: string;
  plan: readonly string[];
  hops: readonly JsonObject[];
  reportText: string | null;
  citations: readonly JsonObject[];
  retrieved: readonly JsonObject[];
  evalSummary: JsonObject;
  confidence: number | null;
  iterationsUsed: number;
  totalCostUsd: number;
  latencyMs: number;
  completedAt: Date | null;
}

/**
 * Upsert a bounded research agent execution in `research_runs`
 * (sole writer: `run-research-agent`).
 */
export async function upsertResearchRun(
  db: Kysely<DB>,
  options: ResearchRunInput,
): Promise<string> {
  const updated = {
    event_id: options.eventId,
    question: options.question,
    status: options.status,
    plan: toJson(options.plan),
    hops: toJson(options.hops),
    report_text: options.reportText,
    citations: toJson(options.citations),
    retrieved: toJson(options.retrieved),
    eval_summary: toJson(options.evalSummary),
    confidence: options.confidence,
    iterations_used: options.iterationsUsed,
    total_cost_usd: options.totalCostUsd,
    latency_ms: options.latencyMs,
    completed_at: options.completedAt,
  };
  const row = await db
    .insertInto("research_runs")
    .values({ ...updated, research_id: options.researchId })
    .onConflict((oc) => oc.column("research_id").doUpdateSet(updated))
    .returning("research_id")
    .executeTakeFirstOrThrow();
  return row.research_id;
}

/**
 * Fetch a single `research_runs` row by `researchId` for `GET /research/:id`
 * and `kb_research_result`.
 */
export async function getResearchRun(
  db: Kysely<DB>,
  researchId: string,
): Promise<JsonObject | null> {
  const row = await db
    .selectFrom("research_runs")
    .selectAll()
    .where("research_id", "=", researchId)
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    research_id: row.research_id,
    event_id: row.event_id,
    question: row.question,
    status: row.status,
    plan: [...(row.plan ?? [])],
    hops: [...(row.hops ?? [])],
    report: row.report_text,
    citations: [...(row.citations ?? [])],
    retrieved_count: (row.retrieved ?? []).length,
    eval_summary: { ...(row.eval_summary ?? {}) },
    confidence: row.confidence === null ? null : Number(row.confidence),
    iterations_used: row.iterations_used,
    total_cost_usd: Number(row.total_cost_usd),
    latency_ms: row.latency_ms,
    created_at: row.created_at.toISOString(),
    completed_at: isoOrNull(row.completed_at),
  };
}

// ---------------------------------------------------------------------- digest

const DIGEST_FALLBACK_ARTICLES = 15;

interface DigestArticleRow {
  id: string;
  canonical_id: string;
  title: string;
  author: string | null;
  url: string;
  published_at: Date;
  pub_slug: string;
  pub_name: string;
}

async function fetchDigestArticles(
  db: Kysely<DB>,
  options: { windowStart: Date; windowEnd: Date; publicationSlugs: readonly string[] },
): Promise<DigestArticleRow[]> {
  const { windowStart, windowEnd, publicationSlugs } = options;
  let base = db
    .selectFrom("articles")
    .innerJoin("publications", "publications.id", "articles.publication_id")
    .select([
      "articles.id",
      "articles.canonical_id",
      "articles.title",
      "articles.author",
      "articles.url",
      "articles.published_at",
      "publications.slug as pub_slug",
      "publications.name as pub_name",
    ])
    .orderBy("articles.published_at", "desc");
  if (publicationSlugs.length > 0) base = base.where("publications.slug", "in", publicationSlugs);

  const inWindow = await base
    .where("articles.published_at", ">=", windowStart)
    .where("articles.published_at", "<=", windowEnd)
    .execute();
  if (inWindow.length > 0) return inWindow;
  // Fallback to most recent articles in the KB so local digests are rich even if
  // RSS feeds haven't published in the last 7 wall-clock days.
  return base.limit(DIGEST_FALLBACK_ARTICLES).execute();
}

async function fetchDigestClaims(db: Kysely<DB>, articleIds: readonly string[]) {
  return db
    .selectFrom("claims")
    .innerJoin("articles", "articles.id", "claims.article_id")
    .innerJoin("publications", "publications.id", "articles.publication_id")
    .select([
      "claims.id",
      "claims.article_id",
      "claims.text",
      "claims.claim_type",
      "claims.quote_span",
      "claims.entities",
      "articles.title",
      "articles.author",
      "articles.url",
      "articles.published_at",
      "publications.slug as pub_slug",
      "publications.name as pub_name",
    ])
    .where("claims.article_id", "in", articleIds)
    .where("claims.valid_to", "is", null)
    .orderBy("claims.confidence", "desc")
    .execute();
}

/** One passage per article (the lowest chunk_index), so citations have valid passage_ids. */
async function fetchFirstPassageIds(
  db: Kysely<DB>,
  articleIds: readonly string[],
): Promise<Map<string, string>> {
  const rows = await db
    .selectFrom("passages")
    .select(["id", "article_id"])
    .where("article_id", "in", articleIds)
    .where("valid_to", "is", null)
    .orderBy("chunk_index", "asc")
    .execute();
  const firstByArticle = new Map<string, string>();
  for (const row of rows) {
    if (!firstByArticle.has(row.article_id)) firstByArticle.set(row.article_id, row.id);
  }
  return firstByArticle;
}

interface TopicEntry {
  slug: string;
  name: string;
  publications: Set<string>;
  authors: Set<string>;
  claimCount: number;
}

function addClaimToTopics(
  topicMap: Map<string, TopicEntry>,
  entities: ReadonlyArray<Record<string, string>>,
  source: { pubSlug: string; author: string },
): void {
  for (const ent of entities) {
    const slug = ent.slug;
    if (slug === undefined) continue;
    let entry = topicMap.get(slug);
    if (entry === undefined) {
      const name = ent.name ?? slug;
      entry = { slug, name, publications: new Set(), authors: new Set(), claimCount: 0 };
      topicMap.set(slug, entry);
    }
    entry.publications.add(source.pubSlug);
    entry.authors.add(source.author);
    entry.claimCount += 1;
  }
}

/** Cross-publication topics first, then by claim count, then by slug. Pure. */
function rankSharedTopics(topicMap: Map<string, TopicEntry>): JsonObject[] {
  const topics = [...topicMap.values()].map((info) => {
    const pubs = [...info.publications].sort();
    return {
      slug: info.slug,
      name: info.name,
      publications: pubs,
      authors: [...info.authors].sort(),
      claim_count: info.claimCount,
      is_cross_publication: pubs.length >= 2,
    };
  });
  topics.sort(
    (a, b) =>
      Number(b.is_cross_publication) - Number(a.is_cross_publication) ||
      b.claim_count - a.claim_count ||
      (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  );
  return topics;
}

async function collectDigestClaims(
  db: Kysely<DB>,
  articleIds: readonly string[],
): Promise<{ claims: JsonObject[]; topics: JsonObject[] }> {
  if (articleIds.length === 0) return { claims: [], topics: [] };
  const claimRows = await fetchDigestClaims(db, articleIds);
  const firstPassageByArticle = await fetchFirstPassageIds(db, articleIds);
  const topicMap = new Map<string, TopicEntry>();
  const claims = claimRows.map((row) => {
    const author = row.author || row.pub_name;
    const entities = row.entities ?? [];
    addClaimToTopics(topicMap, entities, { pubSlug: row.pub_slug, author });
    return {
      passage_id: firstPassageByArticle.get(row.article_id) ?? row.id,
      claim_id: row.id,
      claim_text: row.text,
      claim_type: row.claim_type,
      text: row.quote_span,
      title: row.title,
      author,
      url: row.url,
      publication_slug: row.pub_slug,
      publication_name: row.pub_name,
      published_at: row.published_at.toISOString(),
      topics: [...entities],
    };
  });
  return { claims, topics: rankSharedTopics(topicMap) };
}

/**
 * Gather articles, active claims, and cross-publication topic overlaps
 * for the digest window.
 */
export async function collectWeeklyDigestInputs(
  db: Kysely<DB>,
  options: { windowStart: Date; windowEnd: Date; publicationSlugs?: readonly string[] | null },
): Promise<JsonObject> {
  const articleRows = await fetchDigestArticles(db, {
    windowStart: options.windowStart,
    windowEnd: options.windowEnd,
    publicationSlugs: options.publicationSlugs ?? [],
  });
  const articles = articleRows.map((art) => ({
    article_id: art.id,
    canonical_id: art.canonical_id,
    title: art.title,
    author: art.author || art.pub_name,
    url: art.url,
    publication_slug: art.pub_slug,
    publication_name: art.pub_name,
    published_at: art.published_at.toISOString(),
  }));
  const { claims, topics } = await collectDigestClaims(
    db,
    articleRows.map((art) => art.id),
  );
  return { articles, claims, topics };
}

/** Persist a weekly digest row in `digests` (sole writer: `generate-weekly-digest`). */
export async function insertDigest(
  db: Kysely<DB>,
  options: {
    digestId: string;
    windowStart: Date;
    windowEnd: Date;
    title: string;
    summaryMarkdown: string;
    citations: readonly JsonObject[];
    stats: JsonObject;
  },
): Promise<string> {
  const updated = {
    window_start: options.windowStart,
    window_end: options.windowEnd,
    title: options.title,
    summary_markdown: options.summaryMarkdown,
    citations: toJson(options.citations),
    stats: toJson(options.stats),
  };
  const row = await db
    .insertInto("digests")
    .values({ ...updated, digest_id: options.digestId })
    .onConflict((oc) => oc.column("digest_id").doUpdateSet(updated))
    .returning("digest_id")
    .executeTakeFirstOrThrow();
  return row.digest_id;
}

/** Return the most recent weekly digest from `digests`. */
export async function getLatestDigest(db: Kysely<DB>): Promise<JsonObject | null> {
  const row = await db
    .selectFrom("digests")
    .selectAll()
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    digest_id: row.digest_id,
    window_start: row.window_start.toISOString(),
    window_end: row.window_end.toISOString(),
    title: row.title,
    summary_markdown: row.summary_markdown,
    citations: [...(row.citations ?? [])],
    stats: { ...(row.stats ?? {}) },
    created_at: row.created_at.toISOString(),
  };
}
