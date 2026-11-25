/**
 * Hono app: serves Inngest functions, plus plain HTTP endpoints for
 * ingestion and retrieval. Everything is triggered this way, the way
 * Inngest's own docs describe: send an event, get a handle back, poll for status.
 *
 * Writes (`POST /publications`, `POST /articles`) only send an event and return.
 * Reads (`GET /search`, `POST /ask`) never go through Inngest: they query
 * Postgres directly, because someone is waiting for them.
 *
 * The JSON contract is the one the FastAPI version had: errors are
 * `{ "detail": ... }`, and request validation errors are 422 with
 * `{ "detail": [...] }`.
 */

import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { connect } from "inngest/connect";
import { serve } from "inngest/hono";
import { z } from "zod";
import { settings } from "./config";
import {
  getJobStatus,
  getLatestDigest,
  getLatestEvalReport,
  getResearchRun,
  getSourceProvenance,
  upsertPublication,
} from "./db/queries";
import { getDb, withTransaction } from "./db/session";
import { FUNCTIONS } from "./functions";
import { askQuestion } from "./functions/ask";
import { checkHealth } from "./health";
import { client } from "./inngest-client";
import * as dense from "./retrieval/dense";
import * as hybrid from "./retrieval/hybrid";
import * as sparse from "./retrieval/sparse";
import {
  ARTICLE_DISCOVERED,
  ArticleDiscovered,
  DIGEST_REQUESTED,
  DigestRequested,
  EVAL_RUN_REQUESTED,
  EvalRunRequested,
  PUBLICATION_ADDED,
  PublicationAdded,
  RESEARCH_REQUESTED,
  ResearchRequested,
} from "./schemas/events";
import { canonicalId, researchId } from "./schemas/ids";
import {
  loadPublications,
  type PublicationEntry,
  publicationForManualUrl,
} from "./sources/allowlist";
import { assertPublicUrl, UnsafeUrlError } from "./sources/url-guard";

// --- Request schemas ---------------------------------------------------------

const ArticleManual = z.object({ url: z.string(), title: z.string().nullish() });
const AskRequest = z.object({ question: z.string(), limit: z.number().int().nullish() });
const ResearchCreateRequest = z.object({
  question: z.string(),
  max_iterations: z.number().int().nullish(),
  max_usd: z.number().nullish(),
});
const SearchQuery = z.object({
  q: z.string(),
  mode: z.enum(["hybrid", "sparse", "dense"]).default("hybrid"),
  limit: z.coerce.number().int().min(1).max(25).default(5),
});
const EvalReportQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) });
const InngestRuns = z.object({
  data: z.array(z.object({ status: z.string(), output: z.unknown() })).default([]),
});

// --- Errors with FastAPI's JSON shape ---------------------------------------

/** An error the client sees as `{ "detail": detail }` with `status`. */
class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly detail: unknown,
  ) {
    super(typeof detail === "string" ? detail : `HTTP ${status}`);
  }
}

type Location = "body" | "query";

function validationError(location: Location, issues: z.core.$ZodIssue[]): ApiError {
  const detail = issues.map((issue) => ({
    type: issue.code,
    loc: [location, ...issue.path.map(String)],
    msg: issue.message,
  }));
  return new ApiError(422, detail);
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, location: Location): T {
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(location, result.error.issues);
  return result.data;
}

/** The JSON body, or undefined when the body is empty. Malformed JSON is a 422. */
async function readJsonBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    const msg = `JSON decode error: ${error instanceof Error ? error.message : String(error)}`;
    throw new ApiError(422, [{ type: "json_invalid", loc: ["body"], msg }]);
  }
}

async function parseRequiredBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const body = await readJsonBody(c);
  if (body === undefined) {
    throw new ApiError(422, [{ type: "missing", loc: ["body"], msg: "Field required" }]);
  }
  return parseOrThrow(schema, body, "body");
}

/** Python's `repr()` of a string, for error messages that quote user input. */
function repr(value: string): string {
  return `'${value}'`;
}

/** Python's `uuid.UUID(text)`: 32 hex digits, hyphens/braces/urn prefix optional. Null if invalid. */
export function parseUuid(text: string): string | null {
  const hex = text
    .replace(/^urn:uuid:/i, "")
    .replace(/^\{(.*)\}$/, "$1")
    .replaceAll("-", "")
    .toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  const parts = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20)];
  return [...parts, hex.slice(20)].join("-");
}

// --- Helpers -----------------------------------------------------------------

function traceUrl(eventId: string): string {
  return `${settings.inngestBaseUrl}/event/${eventId}`;
}

/** Send one event and return its id. */
async function sendEvent(name: string, data: Record<string, unknown>): Promise<string> {
  const { ids } = await client.send({ name, data });
  const eventId = ids[0];
  if (eventId === undefined) throw new Error(`Inngest returned no event id for ${name}`);
  return eventId;
}

/** The newest Inngest run for `eventId` (status and output), or nulls when there is none. */
async function fetchInngestRun(
  eventId: string,
): Promise<{ runStatus: string | null; runOutput: unknown }> {
  const headers: Record<string, string> = {};
  if (settings.inngestSigningKey) {
    headers.Authorization = `Bearer ${settings.inngestSigningKey}`;
  }
  let response: Response;
  try {
    response = await fetch(`${settings.inngestBaseUrl}/v1/events/${eventId}/runs`, {
      headers,
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    const detail = `Could not reach the Inngest Dev Server at ${settings.inngestBaseUrl}: ${error}`;
    throw new ApiError(502, detail);
  }
  if (response.status !== 200) return { runStatus: null, runOutput: null };
  const runs = InngestRuns.parse(await response.json()).data;
  const first = runs[0];
  return { runStatus: first?.status ?? null, runOutput: first?.output ?? null };
}

/**
 * Validate a manual URL before any write: it must be public, have a host, and
 * have a path segment. A rejected URL is a 400 with the reason as `detail`.
 */
async function resolveManualUrl(
  url: string,
): Promise<{ pub: PublicationEntry; articleCanonicalId: string }> {
  const publications = loadPublications();
  try {
    await assertPublicUrl(url);
  } catch (error) {
    if (error instanceof UnsafeUrlError) throw new ApiError(400, error.message);
    throw error;
  }
  try {
    const pub = publicationForManualUrl(url, publications);
    return { pub, articleCanonicalId: canonicalId(pub.slug, url) };
  } catch (error) {
    // Both are pure URL checks (no host, no path segment): a client error.
    throw new ApiError(400, error instanceof Error ? error.message : String(error));
  }
}

// --- App ---------------------------------------------------------------------

export const app = new Hono();

app.onError((error, c) => {
  if (error instanceof ApiError) return c.json({ detail: error.detail }, error.status);
  console.error(`${c.req.method} ${c.req.path} failed`, error);
  return c.text("Internal Server Error", 500);
});
app.notFound((c) => c.json({ detail: "Not Found" }, 404));

const inngestHandler = serve({
  client,
  functions: FUNCTIONS,
  ...(settings.inngestSigningKey ? { signingKey: settings.inngestSigningKey } : {}),
});
app.all("/api/inngest", (c) => inngestHandler(c));

app.get("/health", async (c) => c.json(await checkHealth()));

/**
 * Kick off ingestion for one publication. The feed's host must already be
 * listed in `publications.yaml`: `backfill-publication` rejects anything else.
 *
 * Returns immediately with a handle; poll `GET /jobs/{event_id}` for progress.
 */
app.post("/publications", async (c) => {
  const payload = await parseRequiredBody(c, PublicationAdded);
  const eventId = await sendEvent(PUBLICATION_ADDED, payload);
  return c.json({ event_id: eventId, trace_url: traceUrl(eventId), status: "queued" });
});

/**
 * Ingest one article now, ahead of any queued backfill.
 *
 * The event is tagged `via="manual"`, which `ingest-article`'s priority
 * expression turns into a +`priorityManualS` time shift: Inngest schedules
 * the run as if it had arrived that many seconds earlier, so it takes the next
 * free slot for its publication.
 *
 * The URL can be any public http(s) page. A host in `publications.yaml` keeps
 * its publication; any other host gets a `web-<host>` publication, which is
 * never polled. URLs that resolve to a local or private address are rejected.
 */
app.post("/articles", async (c) => {
  const payload = await parseRequiredBody(c, ArticleManual);
  const { pub, articleCanonicalId } = await resolveManualUrl(payload.url);
  const publicationId = await withTransaction((db) =>
    upsertPublication(db, {
      slug: pub.slug,
      name: pub.name,
      feedUrl: pub.feed_url,
      homepage: pub.homepage,
    }),
  );
  const data = ArticleDiscovered.parse({
    canonical_id: articleCanonicalId,
    publication_id: publicationId,
    url: payload.url,
    title: payload.title || "Manual ingestion",
    // Only a fallback: the parse step uses the article's real date if it finds one.
    published_at: new Date(),
    via: "manual",
  });
  const eventId = await sendEvent(ARTICLE_DISCOVERED, data);
  return c.json({
    event_id: eventId,
    trace_url: traceUrl(eventId),
    status: "queued",
    priority_offset_s: settings.priorityManualS,
  });
});

/**
 * Combine this repo's own `jobs` row (article counts) with the Inngest Dev
 * Server's real run status for the event that started the job.
 */
app.get("/jobs/:event_id", async (c) => {
  const eventId = c.req.param("event_id");
  const { runStatus, runOutput } = await fetchInngestRun(eventId);
  // A transaction, so get_job_status's read-repair of jobs.done/status is committed.
  const job = await withTransaction((db) => getJobStatus(db, eventId));

  if (job == null && runStatus === null) {
    throw new ApiError(404, `No job or Inngest run found for event_id=${repr(eventId)}.`);
  }
  return c.json({
    status: job != null ? job.status : runStatus,
    articles_done: job != null ? job.done : null,
    articles_total: job != null ? job.total : null,
    run_status: runStatus,
    // Only surfaces the discovery run's own top-level error.
    failures: runStatus === "Failed" ? [runOutput] : [],
    trace_url: traceUrl(eventId),
  });
});

/**
 * Search passages, no LLM. `hybrid` (the default) fuses full-text
 * and vector search with Reciprocal Rank Fusion; `sparse` and `dense` query one
 * engine each, so you can compare all three on the same query.
 */
app.get("/search", async (c) => {
  const { q, mode, limit } = parseOrThrow(SearchQuery, c.req.query(), "query");
  const engine = { hybrid, sparse, dense }[mode];
  const results = await engine.search(getDb(), q, limit);
  return c.json({ mode, results });
});

/**
 * Answer a question with inline citations. A fast read: it never creates an
 * Inngest run. It saves a snapshot and sends `kb/answer.produced` on its way out.
 */
app.post("/ask", async (c) => {
  const payload = await parseRequiredBody(c, AskRequest);
  return c.json(await askQuestion(getDb(), payload.question, payload.limit));
});

/**
 * Resolve full provenance, verbatim quote, and temporal validity for a
 * `claim_id` or `passage_id`.
 */
app.get("/sources/:claim_or_passage_id", async (c) => {
  const rawId = c.req.param("claim_or_passage_id");
  const targetUuid = parseUuid(rawId.trim());
  if (targetUuid === null) {
    throw new ApiError(400, `Invalid UUID for claim_or_passage_id=${repr(rawId)}.`);
  }
  const provenance = await getSourceProvenance(getDb(), targetUuid);
  if (provenance == null) {
    throw new ApiError(404, `No claim or passage found for id=${repr(rawId)}.`);
  }
  return c.json(provenance);
});

/**
 * Trigger the multi-variant evaluation suite (`run-eval-suite`) via Inngest.
 *
 * Slow work: dispatches `kb/eval.run` and returns an `{event_id, trace_url, status}`
 * handle in <50ms. Poll `GET /jobs/{event_id}` or `GET /evals/latest` for results.
 */
app.post("/evals/run", async (c) => {
  const body = await readJsonBody(c);
  const req = parseOrThrow(EvalRunRequested, body ?? {}, "body");
  const eventId = await sendEvent(EVAL_RUN_REQUESTED, req);
  return c.json({
    event_id: eventId,
    trace_url: traceUrl(eventId),
    suite_name: req.suite_name,
    status: "queued",
  });
});

/**
 * Fast read (<1s): return the latest evaluation report, failure taxonomy counts,
 * recent snapshot critiques, and multi-variant experiment summary.
 */
app.get("/evals/latest", async (c) => {
  const { limit } = parseOrThrow(EvalReportQuery, c.req.query(), "query");
  return c.json(await getLatestEvalReport(getDb(), limit));
});

/**
 * Queue a bounded multi-hop research agent run (`run-research-agent`).
 *
 * Slow work: emits `kb/research.requested` and returns `{research_id, event_id,
 * trace_url, status}` in <50ms. Poll `GET /research/{research_id}` for the report.
 */
app.post("/research", async (c) => {
  const payload = await parseRequiredBody(c, ResearchCreateRequest);
  const rid = researchId();
  const req = ResearchRequested.parse({
    research_id: rid,
    question: payload.question,
    max_iterations: payload.max_iterations ?? null,
    max_usd: payload.max_usd ?? null,
  });
  const eventId = await sendEvent(RESEARCH_REQUESTED, req);
  return c.json({
    research_id: rid,
    event_id: eventId,
    trace_url: traceUrl(eventId),
    status: "queued",
  });
});

/**
 * Fast read (<1s): return the bounded research agent run, hop trace, citations,
 * and evaluation summary from Postgres.
 */
app.get("/research/:research_id_param", async (c) => {
  const researchIdParam = c.req.param("research_id_param");
  const runData = await getResearchRun(getDb(), researchIdParam.trim());
  if (runData == null) {
    throw new ApiError(404, `No research run found for research_id=${repr(researchIdParam)}.`);
  }
  return c.json(runData);
});

/**
 * Trigger `generate-weekly-digest` on demand via Inngest.
 *
 * Slow work: emits `kb/digest.requested` and returns an `{event_id, trace_url, status}`
 * handle in <50ms. Fetch the result via `GET /digests/latest`.
 */
app.post("/digests/run", async (c) => {
  const body = await readJsonBody(c);
  const req = parseOrThrow(
    DigestRequested,
    body ?? { lookback_days: settings.digestLookbackDays },
    "body",
  );
  const eventId = await sendEvent(DIGEST_REQUESTED, req);
  return c.json({
    event_id: eventId,
    trace_url: traceUrl(eventId),
    lookback_days: req.lookback_days,
    status: "queued",
  });
});

/** Fast read (<1s): return the most recent weekly digest from Postgres. */
app.get("/digests/latest", async (c) => {
  const digest = await getLatestDigest(getDb());
  if (digest == null) return c.json({ status: "empty", digest: null });
  return c.json(digest);
});

// --- Inngest Cloud Connect ---------------------------------------------------

/**
 * When running against Inngest Cloud (`INNGEST_DEV=0`), establish an outbound
 * WebSocket worker connection (`connect`) so Inngest Cloud can sync and
 * invoke all functions without needing ngrok, cloudflared, or public ingress.
 * `connect` closes the connection gracefully on SIGINT/SIGTERM by default.
 */
async function startInngestConnect(): Promise<void> {
  // The SDK reads the signing key from INNGEST_SIGNING_KEY, the same variable as settings.
  await connect({ apps: [{ client, functions: FUNCTIONS }] });
  console.info(`Inngest Cloud Connect active (app=${client.id}, functions=${FUNCTIONS.length})`);
}

if (import.meta.main && !settings.inngestDev && settings.inngestSigningKey) {
  startInngestConnect().catch((error: unknown) => {
    console.error("Inngest Cloud Connect failed to start", error);
  });
}

export default { port: settings.labPort, fetch: app.fetch };
