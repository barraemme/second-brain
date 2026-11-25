/**
 * kb/article.ingested | kb/article.updated -> extract-claims.
 *
 * Durable enrichment pipeline:
 * 1. `load-article`: Fetch Article + Publication metadata and prose from Postgres.
 * 2. `extract-claims-llm`: Run `claimExtractorAgent` via `runAgent` (memoized).
 * 3. `validate-quote-spans`: Deterministic verbatim quote-span guardrail + topic
 *    canonicalization (`kb/sources/quote-validator.ts`).
 * 4. `persist-claims-pg`: Supersede prior active claims on edit and upsert new
 *    claims into Postgres `claims`.
 * 5. `sync-claims-memgraph`: Idempotently `MERGE` the `:Publication`, `:Author`,
 *    `:Article`, `:Claim`, `:Topic` subgraph and `[:SUPERSEDES]` edges in Memgraph.
 * 6. `emit-claims-extracted`: Emit `kb/claims.extracted` with `claim_count` and
 *    `dropped_spans`.
 */

import { runAgent } from "../agents/core";
import {
  claimExtractorAgent,
  formatExtractorPrompt,
  heuristicExtractClaims,
} from "../agents/roles/extractor";
import { settings } from "../config";
import { getArticleWithPublication, persistArticleClaims } from "../db/queries";
import { getDb, withTransaction } from "../db/session";
import { type GraphSyncResult, syncArticleClaimsToGraph } from "../graph/client";
import { normalizeAuthor } from "../graph/ontology";
import { client } from "../inngest-client";
import { ClaimExtractionBatch, type ValidatedClaim } from "../schemas/entities";
import {
  ARTICLE_INGESTED,
  ARTICLE_UPDATED,
  ArticleIngested,
  CLAIMS_EXTRACTED,
  ClaimsExtracted,
} from "../schemas/events";
import { validateAndNormalizeClaims } from "../sources/quote-validator";

interface ArticleData {
  article_id: string;
  canonical_id: string;
  url: string;
  title: string;
  author: string | null;
  published_at: string;
  content_hash: string;
  text: string;
  pub_slug: string;
  pub_name: string;
  pub_homepage: string;
}

/** The article and its publication, or null when it is missing or has no text. */
async function loadArticle(articleId: string): Promise<ArticleData | null> {
  const row = await getArticleWithPublication(getDb(), articleId);
  if (row == null) return null;
  const [article, pub] = row;
  if (!article.text.trim()) return null;
  return {
    article_id: article.id,
    canonical_id: article.canonical_id,
    url: article.url,
    title: article.title,
    author: article.author,
    published_at: article.published_at.toISOString(),
    content_hash: article.content_hash,
    text: article.text,
    pub_slug: pub.slug,
    pub_name: pub.name,
    pub_homepage: pub.homepage,
  };
}

function validateQuoteSpans(
  articleData: ArticleData,
  batch: ClaimExtractionBatch,
): { claims: ValidatedClaim[]; dropped_spans: number } {
  const [validated, dropped] = validateAndNormalizeClaims(
    articleData.article_id,
    articleData.content_hash,
    articleData.text,
    batch.claims,
    { fallbackTopic: articleData.pub_name },
  );
  return { claims: validated, dropped_spans: dropped };
}

async function saveClaims(
  articleId: string,
  claims: ValidatedClaim[],
): Promise<{ claim_count: number; supersedes_pairs: Record<string, string>[]; now_iso: string }> {
  const now = new Date();
  const supersedesPairs = await withTransaction((db) =>
    persistArticleClaims(db, { articleId, claims, now }),
  );
  return {
    claim_count: claims.length,
    supersedes_pairs: supersedesPairs,
    now_iso: now.toISOString(),
  };
}

function syncClaimsToGraph(
  articleData: ArticleData,
  claims: ValidatedClaim[],
  supersedesPairs: Record<string, string>[],
  nowIso: string,
): Promise<GraphSyncResult> {
  const authorNode = normalizeAuthor(articleData.author || articleData.pub_name);
  return syncArticleClaimsToGraph({
    pubSlug: articleData.pub_slug,
    pubName: articleData.pub_name,
    pubHomepage: articleData.pub_homepage,
    authorSlug: authorNode.slug,
    authorName: authorNode.name,
    canonicalId: articleData.canonical_id,
    articleId: articleData.article_id,
    url: articleData.url,
    title: articleData.title,
    publishedAt: articleData.published_at,
    contentHash: articleData.content_hash,
    claims: claims.map((c) => ({ ...c, valid_from: nowIso, valid_to: null })),
    supersedesPairs,
    nowIso,
  });
}

async function sendClaimsExtracted(
  articleData: ArticleData,
  claimCount: number,
  droppedSpans: number,
): Promise<{ event_sent: boolean }> {
  const data = ClaimsExtracted.parse({
    article_id: articleData.article_id,
    canonical_id: articleData.canonical_id,
    claim_count: claimCount,
    dropped_spans: droppedSpans,
  });
  await client.send({ name: CLAIMS_EXTRACTED, data });
  return { event_sent: true };
}

export const extractClaims = client.createFunction(
  {
    id: "extract-claims",
    triggers: [{ event: ARTICLE_INGESTED }, { event: ARTICLE_UPDATED }],
    concurrency: [
      // Serialize claim extraction per article so rapid edits never interleave
      { key: "event.data.canonical_id", limit: 1 },
      // Global concurrency cap to protect the API rate limit
      { limit: settings.concurrencyExtractClaims },
    ],
    retries: 3,
  },
  async ({ event, step }) => {
    // ArticleUpdated is the same schema as ArticleIngested, so one parse covers both triggers.
    const payload = ArticleIngested.parse(event.data);

    const articleData = await step.run("load-article", () => loadArticle(payload.article_id));
    if (!articleData) {
      return {
        article_id: payload.article_id,
        canonical_id: payload.canonical_id,
        claim_count: 0,
        dropped_spans: 0,
        status: "skipped_empty",
      };
    }

    const prompt = formatExtractorPrompt({
      title: articleData.title,
      author: articleData.author,
      publicationName: articleData.pub_name,
      articleText: articleData.text,
    });

    let extractionBatch: ClaimExtractionBatch;
    if (settings.openaiApiKey) {
      extractionBatch = await runAgent(
        step,
        claimExtractorAgent,
        prompt,
        "extract-claims-llm",
        payload.article_id,
      );
    } else {
      const rawBatch = await step.run("extract-claims-llm", () =>
        heuristicExtractClaims(articleData.text),
      );
      extractionBatch = ClaimExtractionBatch.parse(rawBatch);
    }

    const validation = await step.run("validate-quote-spans", () =>
      validateQuoteSpans(articleData, extractionBatch),
    );
    const validatedClaims = validation.claims;
    const droppedSpans = validation.dropped_spans;

    const pgResult = await step.run("persist-claims-pg", () =>
      saveClaims(articleData.article_id, validatedClaims),
    );

    await step.run("sync-claims-memgraph", () =>
      syncClaimsToGraph(articleData, validatedClaims, pgResult.supersedes_pairs, pgResult.now_iso),
    );

    await step.run("emit-claims-extracted", () =>
      sendClaimsExtracted(articleData, validatedClaims.length, droppedSpans),
    );

    return {
      article_id: articleData.article_id,
      canonical_id: articleData.canonical_id,
      claim_count: validatedClaims.length,
      dropped_spans: droppedSpans,
    };
  },
);
