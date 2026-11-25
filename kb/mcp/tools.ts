/**
 * The MCP tools.
 *
 * Fast reads (`kb_health`, `kb_search`, `kb_ask`, `kb_list_publications`,
 * `kb_job_status`, `kb_sources`) hit Postgres, Memgraph, and retrieval engines
 * directly and return in under a second - no Inngest run is created for them.
 * Slow work (`kb_add_publication`, `kb_backfill`, `kb_sync`) sends an event to
 * Inngest and returns a handle immediately; progress is polled with `kb_job_status`.
 *
 * Every tool throws an `Error` with a user-facing message on bad input; the MCP
 * server turns it into an `isError` tool result (Python's `ToolError`).
 */

import { z } from "zod";
import { settings } from "../config";
import {
  getJobStatus,
  getLatestDigest,
  getLatestEvalReport,
  getResearchRun,
  getSourceProvenance,
  listPublicationsWithStats,
} from "../db/queries";
import { getDb, withTransaction } from "../db/session";
import { askQuestion } from "../functions/ask";
import { checkHealth } from "../health";
import { client } from "../inngest-client";
import { search } from "../retrieval/hybrid";
import {
  PUBLICATION_ADDED,
  PublicationAdded,
  RESEARCH_REQUESTED,
  ResearchRequested,
} from "../schemas/events";
import { researchId as newResearchId } from "../schemas/ids";
import { loadPublications } from "../sources/allowlist";

const SNIPPET_CHARS = 300;
const JOB_STATUS_TIMEOUT_MS = 5_000;
// Rough per-publication estimate shown to the caller before discovery runs.
const EXPECTED_ARTICLES_PER_PUBLICATION = 20;

type ToolResult = Record<string, unknown>;

function traceUrl(eventId: string): string {
  return `${settings.inngestBaseUrl}/event/${eventId}`;
}

/** The first id of a `client.send` result; a send that returns none is a bug upstream. */
function firstEventId(ids: readonly string[]): string {
  const first = ids[0];
  if (first === undefined) throw new Error("Inngest accepted the event but returned no event id.");
  return first;
}

/** Python's `repr(str)` for messages that quote user input. */
function repr(value: string): string {
  return `'${value}'`;
}

export async function kbHealth(): Promise<ToolResult> {
  return checkHealth();
}

export async function kbAddPublication(feedUrl: string): Promise<ToolResult> {
  const payload = PublicationAdded.parse({ feed_url: feedUrl });
  const { ids } = await client.send({ name: PUBLICATION_ADDED, data: payload });
  const eventId = firstEventId(ids);
  return { event_id: eventId, trace_url: traceUrl(eventId), status: "queued" };
}

export async function kbSearch(query: string, limit = 5): Promise<ToolResult> {
  const results = await search(getDb(), query, limit);
  const formatted = results.map((r) => ({ ...r, snippet: String(r.text).slice(0, SNIPPET_CHARS) }));
  return { results: formatted };
}

export async function kbAsk(question: string): Promise<ToolResult> {
  return { ...(await askQuestion(getDb(), question)) };
}

export async function kbBackfill(publication = "all"): Promise<ToolResult> {
  const pubs = loadPublications();
  const targetPubs =
    publication === "all"
      ? pubs
      : pubs.filter((p) => p.slug === publication || p.feed_url === publication);
  if (targetPubs.length === 0) {
    const what = publication === "all" ? "No publications" : `Publication ${repr(publication)}`;
    throw new Error(`${what} not found in publications.yaml allowlist.`);
  }

  const events = targetPubs.map((p) => ({
    name: PUBLICATION_ADDED,
    data: PublicationAdded.parse({ feed_url: p.feed_url }),
  }));
  const { ids } = await client.send(events);
  const firstId = firstEventId(ids);
  return {
    event_id: firstId,
    trace_url: traceUrl(firstId),
    expected_articles: targetPubs.length * EXPECTED_ARTICLES_PER_PUBLICATION,
    publications: targetPubs.map((p) => p.slug),
  };
}

const InngestRuns = z.looseObject({
  data: z
    .array(
      z.looseObject({
        status: z.string(),
        output: z.unknown().optional(),
        steps: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]).nullish(),
      }),
    )
    .nullish(),
});

/** The Inngest Dev Server's view of the first run for an event, or nulls when it has none. */
async function fetchInngestRun(eventId: string) {
  const headers: Record<string, string> = {};
  if (settings.inngestSigningKey) headers.Authorization = `Bearer ${settings.inngestSigningKey}`;
  const runsUrl = `${settings.inngestBaseUrl}/v1/events/${eventId}/runs`;
  let response: Response;
  try {
    response = await fetch(runsUrl, {
      headers,
      signal: AbortSignal.timeout(JOB_STATUS_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `Could not reach the Inngest Dev Server at ${settings.inngestBaseUrl}: ${error}`,
      { cause: error },
    );
  }
  if (response.status !== 200) return { runStatus: null, runOutput: null, stepsCompleted: 0 };
  const run = InngestRuns.parse(await response.json()).data?.[0];
  if (run === undefined) return { runStatus: null, runOutput: null, stepsCompleted: 0 };
  const steps = run.steps ?? {};
  const stepsCompleted = Array.isArray(steps) ? steps.length : Object.keys(steps).length;
  return { runStatus: run.status, runOutput: run.output ?? null, stepsCompleted };
}

export async function kbJobStatus(eventId: string): Promise<ToolResult> {
  const { runStatus, runOutput, stepsCompleted } = await fetchInngestRun(eventId);
  const job = await withTransaction((db) => getJobStatus(db, eventId));

  if (!job && runStatus === null) {
    throw new Error(
      `No job or Inngest run found for event_id=${repr(eventId)}. ` +
        "Check that it's the id returned by kb_add_publication or kb_backfill.",
    );
  }

  return {
    status: job ? job.status : runStatus,
    steps_completed: stepsCompleted,
    articles_ingested: job ? job.done : 0,
    articles_done: job ? job.done : null,
    articles_total: job ? job.total : null,
    run_status: runStatus,
    failures: runStatus === "Failed" ? [runOutput] : [],
    trace_url: traceUrl(eventId),
  };
}

export async function kbListPublications(): Promise<ToolResult> {
  return { publications: await listPublicationsWithStats(getDb()) };
}

export async function kbSync(publication?: string | null): Promise<ToolResult> {
  const { ids } = await client.send({
    name: "kb/feed.poll",
    data: publication ? { publication } : {},
  });
  const eventId = firstEventId(ids);
  return { event_id: eventId, trace_url: traceUrl(eventId), status: "poll_triggered" };
}

export async function kbSources(claimOrPassageId: string): Promise<ToolResult> {
  const parsed = z.guid().safeParse(claimOrPassageId.trim());
  if (!parsed.success) {
    throw new Error(`Invalid UUID for claim_or_passage_id=${repr(claimOrPassageId)}.`);
  }
  const provenance = await getSourceProvenance(getDb(), parsed.data.toLowerCase());
  if (!provenance) {
    throw new Error(`No claim or passage found for claim_or_passage_id=${repr(claimOrPassageId)}.`);
  }
  return provenance;
}

export async function kbEvalReport(limit = 10): Promise<ToolResult> {
  return getLatestEvalReport(getDb(), limit);
}

export async function kbResearch(
  question: string,
  maxIterations = 3,
  maxUsd = 0.25,
): Promise<ToolResult> {
  const rid = newResearchId();
  const req = ResearchRequested.parse({
    research_id: rid,
    question,
    max_iterations: maxIterations,
    max_usd: maxUsd,
  });
  const { ids } = await client.send({ name: RESEARCH_REQUESTED, data: req });
  const eventId = firstEventId(ids);
  return { research_id: rid, event_id: eventId, trace_url: traceUrl(eventId), status: "queued" };
}

export async function kbResearchResult(researchId: string): Promise<ToolResult> {
  const runData = await getResearchRun(getDb(), researchId.trim());
  if (!runData) {
    throw new Error(
      `No research run found for research_id=${repr(researchId)}. ` +
        "Check that the ID was returned by kb_research and that Inngest has started the run.",
    );
  }
  return runData;
}

export async function kbWeeklyDigest(): Promise<ToolResult> {
  const digest = await getLatestDigest(getDb());
  if (!digest) {
    return {
      status: "empty",
      digest: null,
      message: "No weekly digest has been generated yet. Trigger POST /digests/run first.",
    };
  }
  return digest;
}
