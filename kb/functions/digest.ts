/**
 * Automated weekly digest (`generate-weekly-digest`).
 *
 * Dual-triggered by:
 * 1. Cron (`settings.digestCron`, default Mondays at 08:00 UTC: `"0 8 * * 1"`).
 * 2. On-demand event (`kb/digest.requested` from `POST /digests/run`).
 *
 * Executes 4 durable steps:
 * 1. `collect-weekly-window`: Gather articles, active verified claims, and cross-publication
 *    `:Topic` hubs from the lookback window.
 * 2. `synthesize-weekly-digest`: Write the structured weekly markdown briefing with inline
 *    `[k]` citations via `weeklyDigestAgent` (or deterministic fallback when keyless).
 * 3. `verify-and-persist-digest`: Run Level 1 deterministic citation checks (`FM-1`-`FM-3`)
 *    and upsert the row into `digests`.
 * 4. `emit-digest-published`: Emit `kb/digest.published`.
 */

import { z } from "zod";
import { callLlm } from "../agents/providers";
import {
  extractCitedEntries,
  formatEvidenceContext,
  heuristicSynthesizeDigest,
  weeklyDigestAgent,
} from "../agents/roles/researcher";
import { settings } from "../config";
import { collectWeeklyDigestInputs, insertDigest } from "../db/queries";
import { getDb, withTransaction } from "../db/session";
import type { JsonObject } from "../db/types";
import { runDeterministicChecks } from "../evals/deterministic";
import { client } from "../inngest-client";
import {
  DIGEST_PUBLISHED,
  DIGEST_REQUESTED,
  DigestPublished,
  DigestRequested,
} from "../schemas/events";
import { ARTICLE_CLAIM_NAMESPACE } from "../schemas/ids";

const JsonRecord = z.record(z.string(), z.unknown());

/** The `collect-weekly-window` step output, re-parsed after the JSON round trip. */
const WindowData = z.looseObject({
  articles: z.array(JsonRecord),
  claims: z.array(JsonRecord),
  topics: z.array(JsonRecord),
});
type WindowData = z.infer<typeof WindowData>;

const PROMPT_LIMIT = 10;
const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` of a date in UTC. Pure. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The digest window: `[now rounded down to the hour - lookbackDays, that hour]`, in UTC. Pure. */
export function digestWindow(now: Date, lookbackDays: number) {
  const windowEnd = new Date(now);
  windowEnd.setUTCMinutes(0, 0, 0);
  const windowStart = new Date(windowEnd.getTime() - Math.max(lookbackDays, 1) * MS_PER_DAY);
  const title = `The Substack Brain Weekly Digest (${isoDay(windowStart)} to ${isoDay(windowEnd)})`;
  // Deterministic UUIDv5 per (window_start_date, window_end_date) so re-running the
  // same day's digest updates in place without duplicating rows.
  const digestId = Bun.randomUUIDv5(
    `digest:${isoDay(windowStart)}:${isoDay(windowEnd)}`,
    ARTICLE_CLAIM_NAMESPACE,
  );
  return { windowStart, windowEnd, title, digestId };
}

function buildDigestPrompt(title: string, data: WindowData, topClaims: JsonObject[]): string {
  const topicsSummary = data.topics
    .slice(0, 8)
    .map((t) => {
      const publications = Array.isArray(t.publications) ? t.publications.map(String) : [];
      return `- ${String(t.name)} (publications: ${publications.join(", ")}; claims: ${String(t.claim_count)})`;
    })
    .join("\n");
  const articleTitles = data.articles.slice(0, 10).map((a) => String(a.title));
  return (
    `Digest Title: ${title}\n` +
    `Articles Covered (${data.articles.length}): ${articleTitles.join(", ")}\n\n` +
    `Canonical Topics This Week:\n${topicsSummary || "None"}\n\n` +
    `Numbered Claims & Verbatim Quotes:\n${formatEvidenceContext(topClaims)}\n\n` +
    "Write the weekly markdown digest with inline [k] citations:"
  );
}

async function synthesizeDigest(
  title: string,
  data: WindowData,
  topClaims: JsonObject[],
): Promise<unknown> {
  if (topClaims.length === 0) {
    return { output: heuristicSynthesizeDigest(title, [], data.topics) };
  }
  if (settings.openaiApiKey) {
    return callLlm({
      systemPrompt: weeklyDigestAgent.system_prompt,
      userInput: buildDigestPrompt(title, data, topClaims),
      model: weeklyDigestAgent.model,
      maxTokens: weeklyDigestAgent.max_tokens,
      outputSchema: null,
    });
  }
  return { output: heuristicSynthesizeDigest(title, topClaims, data.topics) };
}

interface DigestDraft {
  digestId: string;
  windowStart: Date;
  windowEnd: Date;
  title: string;
  summaryMarkdown: string;
  citations: JsonObject[];
}

/** Body of `verify-and-persist-digest`: deterministic checks, then upsert into `digests`. */
async function verifyAndSaveDigest(draft: DigestDraft, data: WindowData, topClaims: JsonObject[]) {
  const det = runDeterministicChecks({
    answerText: draft.summaryMarkdown,
    citations: draft.citations,
    retrieved: topClaims,
    promptLimit: PROMPT_LIMIT,
  });
  const stats: JsonObject = {
    articles_count: data.articles.length,
    claims_count: data.claims.length,
    topics_count: data.topics.length,
    cross_pub_disagreements_count: data.topics.filter((t) => t.is_cross_publication).length,
    top_topics: data.topics.slice(0, 5).map((t) => String(t.name)),
    deterministic_passed: det.passed,
    deterministic_checks: det.checks,
    failure_codes: det.failure_codes,
  };
  const persistedId = await withTransaction((db) => insertDigest(db, { ...draft, stats }));
  return { digest_id: String(persistedId), title: draft.title, stats };
}

export const generateWeeklyDigest = client.createFunction(
  {
    id: "generate-weekly-digest",
    name: "Generate Weekly Knowledge Base Digest",
    triggers: [{ cron: settings.digestCron }, { event: DIGEST_REQUESTED }],
    retries: 2,
  },
  async ({ event, step }) => {
    const rawData: unknown = event.data ?? {};
    const hasData =
      typeof rawData === "object" && rawData !== null && Object.keys(rawData).length > 0;
    const req = DigestRequested.parse(
      hasData ? rawData : { lookback_days: settings.digestLookbackDays },
    );
    const { windowStart, windowEnd, title, digestId } = digestWindow(new Date(), req.lookback_days);

    const windowRaw = await step.run("collect-weekly-window", () =>
      collectWeeklyDigestInputs(getDb(), {
        windowStart,
        windowEnd,
        publicationSlugs: req.publication_slugs ?? null,
      }),
    );
    const data = WindowData.parse(windowRaw);
    const topClaims = data.claims.slice(0, PROMPT_LIMIT);

    const synthRes = await step.run("synthesize-weekly-digest", () =>
      synthesizeDigest(title, data, topClaims),
    );
    const synthOutput =
      typeof synthRes === "object" && synthRes !== null && "output" in synthRes
        ? synthRes.output
        : synthRes;
    const summaryMarkdown = String(synthOutput);
    const citations = extractCitedEntries(summaryMarkdown, topClaims);

    const draft: DigestDraft = {
      digestId,
      windowStart,
      windowEnd,
      title,
      summaryMarkdown,
      citations,
    };
    const persisted = await step.run("verify-and-persist-digest", () =>
      verifyAndSaveDigest(draft, data, topClaims),
    );

    const publishedEvt = DigestPublished.parse({
      digest_id: digestId,
      window_start: windowStart,
      window_end: windowEnd,
      article_count: data.articles.length,
      claim_count: data.claims.length,
      disagreements_count: data.topics.filter((t) => t.is_cross_publication).length,
    });
    await step.sendEvent("emit-digest-published", { name: DIGEST_PUBLISHED, data: publishedEvt });

    return persisted;
  },
);
