/**
 * POST /ask: answer a question from the knowledge base, with inline citations.
 *
 * This is a fast read, so it never creates an Inngest run. A workflow engine is
 * for expensive work you'd hate to lose; here someone is waiting, and retrying
 * in three minutes is useless. So `askQuestion` talks to Postgres and OpenAI
 * directly, saves a snapshot of everything it did, and only then sends a
 * fire-and-forget `kb/answer.produced` event for the evaluators.
 */

import type { Kysely } from "kysely";
import type OpenAI from "openai";
import { ASK_SYNTHESIZER_SYSTEM_PROMPT } from "../agents/prompts";
import { getOpenaiClient } from "../agents/providers";
import { settings } from "../config";
import { withTransaction } from "../db/session";
import type { DB } from "../db/types";
import { client } from "../inngest-client";
import { hybridSearch } from "../retrieval/hybrid";
import { recordSnapshot } from "../retrieval/snapshot";
import { ANSWER_PRODUCED, AnswerProduced } from "../schemas/events";

export const SYSTEM_PROMPT = ASK_SYNTHESIZER_SYSTEM_PROMPT;

/** A retrieved passage as `hybridSearch` returns it (snake_case data keys). */
export type Passage = Record<string, unknown>;

// A type alias, not an interface, so it stays assignable to the JSONB `JsonObject` type.
export type Citation = {
  citation_idx: number;
  passage_id: unknown;
  title: unknown;
  author: unknown;
  url: unknown;
  claim_id?: unknown;
  claim_type?: unknown;
};

export interface AskResult {
  answer: string;
  citations: Citation[];
  as_of: string;
  snapshot_id: string;
  latency_ms: number;
}

export function formatContext(passages: Passage[]): string {
  return passages
    .map((p, i) => {
      const header =
        `[${i + 1}] (Title: ${p.title ?? "Unknown"} | ` +
        `Author: ${p.author || "Unknown"} | URL: ${p.url})`;
      let body = String(p.text ?? "");
      if (p.claim_text) {
        const claimType = p.claim_type || "claim";
        body = `Attributed Claim (${claimType}): ${p.claim_text}\nPassage: ${body}`;
      }
      return `${header}\n${body}`;
    })
    .join("\n\n");
}

function citation(idx: number, passage: Passage): Citation {
  const cit: Citation = {
    citation_idx: idx,
    passage_id: passage.passage_id,
    title: passage.title,
    author: passage.author,
    url: passage.url,
  };
  if (passage.claim_id) {
    cit.claim_id = passage.claim_id;
    cit.claim_type = passage.claim_type ?? null;
  }
  return cit;
}

/** The newest parseable `published_at` among `passages`, or null. Unparseable dates are skipped. */
export function newestDate(passages: Passage[]): Date | null {
  let newest: Date | null = null;
  for (const p of passages) {
    const raw = p.published_at;
    if (!raw || !(typeof raw === "string" || raw instanceof Date)) continue;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) continue;
    if (newest === null || date > newest) newest = date;
  }
  return newest;
}

async function synthesize(llm: OpenAI, question: string, passages: Passage[]): Promise<string> {
  const prompt =
    `Context passages:\n${formatContext(passages)}\n\n` +
    `Question: ${question}\n\n` +
    "Answer with inline citations:";
  try {
    const response = await llm.chat.completions.create({
      model: settings.synthesisModel,
      max_tokens: settings.synthesisMaxTokens,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    });
    return response.choices[0]?.message.content || "(no response)";
  } catch (error) {
    console.error("LLM synthesis failed", error);
    const name = error instanceof Error ? error.name : typeof error;
    const message = error instanceof Error ? error.message : String(error);
    return `LLM synthesis failed (${name}): ${message}`;
  }
}

async function sendAnswerProduced(snapshotId: string, retrieverVariant: string): Promise<void> {
  try {
    await client.send({
      name: ANSWER_PRODUCED,
      data: AnswerProduced.parse({
        snapshot_id: snapshotId,
        retriever_variant: retrieverVariant,
      }),
    });
  } catch (error) {
    // Telemetry must never fail the user's request, but it shouldn't fail
    // silently either. The snapshot is already committed, so nothing is lost.
    console.error(`Failed to emit ${ANSWER_PRODUCED} for ${snapshotId}`, error);
  }
}

/** Synthesize an answer and keep only the passages the model actually cited. */
async function answerWithCitations(
  question: string,
  topPassages: Passage[],
): Promise<{ answerText: string; citations: Citation[] }> {
  if (topPassages.length === 0) {
    return {
      answerText: "No relevant passages were found in the knowledge base for this question.",
      citations: [],
    };
  }
  const answerText = await synthesize(getOpenaiClient(), question, topPassages);
  // Only the passages the model actually cited become citations.
  const citations = topPassages
    .map((p, i) => ({ p, idx: i + 1 }))
    .filter(({ idx }) => answerText.includes(`[${idx}]`))
    .map(({ p, idx }) => citation(idx, p));
  return { answerText, citations };
}

/**
 * Answer `question`. `db` is used for retrieval; the snapshot is written in its
 * own transaction, committed before the `kb/answer.produced` event is sent.
 */
export async function askQuestion(
  db: Kysely<DB>,
  question: string,
  limit?: number | null,
): Promise<AskResult> {
  const startTime = performance.now();
  const retrieverVariant = `hybrid_3way_rrf_k${settings.rrfK}`;

  // 1. Hybrid retrieval: the top passages go into the prompt, ALL candidates
  //    go into the snapshot.
  const [topPassages, allCandidates] = await hybridSearch(
    db,
    question,
    limit || settings.retrievalLimit,
  );

  // 2. Answer with OpenAI, citing passages as [1], [2], ...
  const { answerText, citations } = await answerWithCitations(question, topPassages);

  // 3. as_of: publication date of the newest CITED source (falls back to all
  //    retrieved passages, then to now), so readers know how fresh the answer is.
  const citedIds = new Set(citations.map((c) => c.passage_id));
  const cited = topPassages.filter((p) => citedIds.has(p.passage_id));
  const asOf = newestDate(cited) ?? newestDate(topPassages) ?? new Date();

  const latencyMs = Math.trunc(performance.now() - startTime);

  // 4. Snapshot first, and committed, BEFORE anything is sent anywhere.
  const snapshotId = await withTransaction((tx) =>
    recordSnapshot(tx, {
      question,
      answerText,
      citations,
      retrieved: allCandidates,
      retrieverVariant,
      asOf,
      latencyMs,
    }),
  );

  // 5. Fire-and-forget: the user doesn't wait for the event to be delivered.
  //    sendAnswerProduced catches and logs its own errors.
  void sendAnswerProduced(snapshotId, retrieverVariant);

  return {
    answer: answerText,
    citations,
    as_of: asOf.toISOString(),
    snapshot_id: snapshotId,
    latency_ms: latencyMs,
  };
}
