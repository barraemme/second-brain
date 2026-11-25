/**
 * OpenAI embeddings, batched into as few provider calls as possible.
 *
 * Returns a JSON-serializable object carrying a top-level `usage` key: the
 * convention `CostCaptureMiddleware` (`kb/inngest-client.ts`) recognizes to
 * record cost into the `costs` table, without every embedding/LLM call site
 * having to write to the database itself.
 */

import { getOpenaiClient } from "../agents/providers";
import { settings } from "../config";
import type { UsageRecord } from "../inngest-client";

export interface EmbeddingResult {
  embeddings: number[][];
  usage: UsageRecord;
}

function usageFor(totalTokens: number): UsageRecord {
  const estUsd = (totalTokens / 1_000_000) * settings.embeddingPricePerMillionTokens;
  return {
    model: settings.embeddingModel,
    input_tokens: totalTokens,
    output_tokens: 0,
    est_usd: Math.round(estUsd * 1e6) / 1e6,
  };
}

/** Embed `texts` with the provider (network call), in batches of `embeddingBatchSize`. */
export async function embedTexts(texts: readonly string[]): Promise<EmbeddingResult> {
  const batchSize = settings.embeddingBatchSize;
  if (batchSize < 1) throw new Error(`embeddingBatchSize must be >= 1, got ${batchSize}`);

  const embeddings: number[][] = [];
  let totalTokens = 0;
  for (let start = 0; start < texts.length; start += batchSize) {
    const response = await getOpenaiClient().embeddings.create({
      input: texts.slice(start, start + batchSize),
      model: settings.embeddingModel,
      dimensions: settings.embeddingDimensions,
    });
    // The API does not guarantee response order matches input order.
    const ordered = [...response.data].sort((a, b) => a.index - b.index);
    embeddings.push(...ordered.map((item) => item.embedding));
    totalTokens += response.usage.total_tokens;
  }

  if (embeddings.length !== texts.length) {
    throw new Error(`embedTexts: got ${embeddings.length} embeddings for ${texts.length} texts`);
  }
  return { embeddings, usage: usageFor(totalTokens) };
}
