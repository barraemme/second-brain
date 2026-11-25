/**
 * kb/article.discovered -> ingest-article.
 *
 * Each step below is retried and memoized independently:
 * a failure in `embed` re-runs only `embed`, never re-fetching
 * or re-parsing the article. Re-sending the same event produces zero new rows
 * (upserts throughout: `articles` by `canonical_id`, `passages` by
 * `(article_id, chunk_index)`), so retrying a failed article is always safe.
 *
 * Adds flow control, configured on the function itself so Inngest
 * enforces it in its queue, before any of our code runs:
 *
 * - concurrency, keyed by publication: at most N articles per website at once;
 * - throttle, global: at most N runs START per minute, to protect the OpenAI quota;
 * - priority: manual submissions (`POST /articles`) jump ahead of backfill runs.
 *
 * There is deliberately no Inngest `idempotency` key. It would block re-sending
 * the same article for 24h. Duplicates are already prevented by the
 * backfill's "skip what's stored" filter and by the upserts above.
 */

import { NonRetriableError } from "inngest";
import { settings } from "../config";
import {
  getActiveClaimsForArticle,
  getArticleByCanonicalId,
  insertPassagesFresh,
  replacePassages,
  supersedePassages,
  upsertArticle,
} from "../db/queries";
import { getDb, withTransaction } from "../db/session";
import { client } from "../inngest-client";
import {
  ARTICLE_DISCOVERED,
  ARTICLE_INGESTED,
  ARTICLE_UPDATED,
  ArticleDiscovered,
  ArticleIngested,
} from "../schemas/events";
import { assertAllowed, loadPublications } from "../sources/allowlist";
import { chunkText } from "../sources/chunking";
import { embedTexts } from "../sources/embedder";
import { fetchArticle } from "../sources/fetcher";
import { parseHtml } from "../sources/parser";
import { UnsafeUrlError } from "../sources/url-guard";

interface FetchedHtml {
  url: string;
  html: string;
  status_code: number;
}

/** A parsed article as a step output: `published_at` is an ISO string. */
interface ParsedJson {
  title: string;
  author: string | null;
  published_at: string;
  text: string;
  content_hash: string;
}

interface ContentChange {
  is_new: boolean;
  changed: boolean;
  article_id: string | null;
  needs_claims?: boolean;
}

interface Persisted {
  article_id: string;
  passage_count: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkAllowlist(payload: ArticleDiscovered): void {
  // Manual articles may come from any public site: fetchArticle's URL guard
  // protects them. Feed articles must stay inside publications.yaml.
  if (payload.via === "manual") return;
  const publications = loadPublications();
  try {
    assertAllowed(payload.url, publications);
  } catch (error) {
    throw new NonRetriableError(errorMessage(error), { cause: error });
  }
}

async function fetchHtml(url: string): Promise<FetchedHtml> {
  try {
    const page = await fetchArticle(url);
    return { url: page.url, html: page.html, status_code: page.status_code };
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      throw new NonRetriableError(error.message, { cause: error });
    }
    throw error;
  }
}

function parsePage(page: FetchedHtml, fallbackPublishedAt: Date): ParsedJson {
  const article = parseHtml(page.html, page.url, { fallbackPublishedAt });
  return { ...article, published_at: article.published_at.toISOString() };
}

async function checkContentChange(
  canonicalId: string,
  contentHash: string,
): Promise<ContentChange> {
  const db = getDb();
  const existing = await getArticleByCanonicalId(db, canonicalId);
  if (!existing) return { is_new: true, changed: true, article_id: null };
  if (existing.content_hash === contentHash) {
    const activeClaims = await getActiveClaimsForArticle(db, existing.id);
    return {
      is_new: false,
      changed: false,
      article_id: existing.id,
      needs_claims: activeClaims.length === 0,
    };
  }
  return { is_new: false, changed: true, article_id: existing.id };
}

/** Write the article and its passages in one transaction. */
async function savePassages(
  payload: ArticleDiscovered,
  input: { pageUrl: string; parsed: ParsedJson; chunks: string[]; embeddings: number[][] },
  isUpdate: boolean,
): Promise<Persisted> {
  const { pageUrl, parsed, chunks, embeddings } = input;
  if (chunks.length !== embeddings.length) {
    throw new Error(
      `ingest-article: ${chunks.length} chunks but ${embeddings.length} embeddings for ${payload.canonical_id}`,
    );
  }
  const passages = chunks.map((text, i) => ({
    chunk_index: i,
    text,
    embedding: embeddings[i] ?? [],
  }));
  return withTransaction(async (db) => {
    const articleId = await upsertArticle(db, {
      canonicalId: payload.canonical_id,
      publicationId: payload.publication_id,
      url: pageUrl,
      title: parsed.title,
      author: parsed.author,
      publishedAt: new Date(parsed.published_at),
      contentHash: parsed.content_hash,
      text: parsed.text,
    });
    let passageCount: number;
    if (isUpdate) {
      await supersedePassages(db, articleId);
      passageCount = await insertPassagesFresh(db, { articleId, passages });
    } else {
      passageCount = await replacePassages(db, { articleId, passages });
    }
    return { article_id: articleId, passage_count: passageCount };
  });
}

async function sendArticleEvent(
  name: typeof ARTICLE_INGESTED | typeof ARTICLE_UPDATED,
  data: { canonical_id: string; article_id: string; content_hash: string; passage_count: number },
): Promise<{ event_sent: boolean }> {
  await client.send({ name, data: ArticleIngested.parse(data) });
  return { event_sent: true };
}

export const ingestArticle = client.createFunction(
  {
    id: "ingest-article",
    triggers: [{ event: ARTICLE_DISCOVERED }],
    // A separate limit for each publication, so we never hit one website with
    // more than N requests at once, and one big backfill can't starve the others.
    concurrency: [{ key: "event.data.publication_id", limit: settings.concurrencyPerPublication }],
    // No key: the OpenAI quota is shared by every publication, so the limit is too.
    // Throttling limits run STARTS, not steps; embedTexts sends a whole article
    // in one request, which keeps "runs per minute" close to "requests per minute".
    throttle: { limit: settings.ingestRunsPerMinute, period: "1m" },
    // Priority is a time shift in seconds, not a rank: +600 schedules a manual run
    // as if it had arrived 10 minutes earlier, and -600 pushes backfill runs 10
    // minutes later, so a manual article gets up to 20 minutes of head start.
    priority: {
      run: `event.data.via == 'manual' ? ${settings.priorityManualS} : ${settings.priorityBackfillS}`,
    },
    retries: 3,
  },
  async ({ event, step }) => {
    const payload = ArticleDiscovered.parse(event.data);

    await step.run("check-allowlist", () => checkAllowlist(payload));
    const page = await step.run("fetch-html", () => fetchHtml(payload.url));
    const parsed = await step.run("parse", () => parsePage(page, payload.published_at));
    const changeInfo = await step.run("check-content-change", () =>
      checkContentChange(payload.canonical_id, parsed.content_hash),
    );

    if (!changeInfo.changed) {
      const articleId = String(changeInfo.article_id);
      if (changeInfo.needs_claims) {
        await step.run("emit-for-enrichment", () =>
          sendArticleEvent(ARTICLE_INGESTED, {
            canonical_id: payload.canonical_id,
            article_id: articleId,
            content_hash: parsed.content_hash,
            passage_count: 0,
          }),
        );
      }
      return { article_id: articleId, passage_count: 0, status: "unchanged" };
    }

    const isUpdate = !changeInfo.is_new;
    const chunks = await step.run("chunk", () =>
      chunkText(parsed.text, {
        chunkSize: settings.chunkSize,
        chunkOverlap: settings.chunkOverlap,
      }),
    );
    const embedResult = await step.run("embed", () => embedTexts(chunks));
    const persisted = await step.run("persist", () =>
      savePassages(
        payload,
        { pageUrl: page.url, parsed, chunks, embeddings: embedResult.embeddings },
        isUpdate,
      ),
    );

    await step.run("emit", () =>
      sendArticleEvent(isUpdate ? ARTICLE_UPDATED : ARTICLE_INGESTED, {
        canonical_id: payload.canonical_id,
        article_id: persisted.article_id,
        content_hash: parsed.content_hash,
        passage_count: persisted.passage_count,
      }),
    );

    return persisted;
  },
);
