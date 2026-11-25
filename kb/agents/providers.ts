/**
 * Thin async wrapper around OpenAI with token and USD cost calculation.
 *
 * Every call returns a `usage` record shaped for `CostCaptureMiddleware`
 * (`kb/inngest-client.ts`) and can also write directly to the `costs` table when
 * invoked outside an Inngest step middleware context.
 */

import OpenAI from "openai";
import { z } from "zod";
import { settings } from "../config";
import { insertCost } from "../db/queries";
import { withTransaction } from "../db/session";
import type { UsageRecord } from "../inngest-client";

let openaiClient: OpenAI | undefined;

// Per-million-token pricing table (input_usd, output_usd). Updated for OpenAI models
// with local-compatible pricing estimates.
export const MODEL_PRICING_PER_MTOK: Readonly<Record<string, readonly [number, number]>> = {
  // OpenAI models
  "gpt-4o": [2.5, 10.0],
  "gpt-4o-mini": [0.15, 0.6],
  "gpt-4-turbo": [10.0, 30.0],
  "gpt-4": [30.0, 60.0],
  "gpt-3.5-turbo": [0.5, 1.5],
  "claude-haiku-5-5": [1.0, 5.0],
  "claude-haiku-4-5": [1.0, 5.0],
  "claude-haiku-4-5-20251001": [1.0, 5.0],
  "claude-3-5-haiku-latest": [0.8, 4.0],
  "claude-sonnet-4-20250514": [3.0, 15.0],
  "claude-sonnet-4-5": [3.0, 15.0],
  "claude-sonnet-5-5": [3.0, 15.0],
  "claude-3-5-sonnet-latest": [3.0, 15.0],
};

// A model missing from the table (e.g. a local model behind OPENAI_API_BASE) costs nothing.
const UNKNOWN_MODEL_PRICING: readonly [number, number] = [0, 0];

const DEFAULT_MAX_TOKENS = 2048;

export interface LlmResult {
  output: unknown;
  usage: UsageRecord;
}

export interface CallLlmOptions {
  systemPrompt: string;
  userInput: string;
  model: string;
  maxTokens?: number;
  outputSchema?: z.ZodType | null;
  articleId?: string | null;
  persistCost?: boolean;
}

/** Return a lazily-initialized OpenAI client. */
export function getOpenaiClient(): OpenAI {
  openaiClient ??= new OpenAI({
    apiKey: settings.openaiApiKey || "sk-local",
    baseURL: settings.openaiApiBase,
  });
  return openaiClient;
}

/** Compute estimated USD cost from input and output token counts. */
export function estimateLlmCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  if (inputTokens < 0 || outputTokens < 0) {
    throw new Error(`estimateLlmCostUsd: negative token count (${inputTokens}, ${outputTokens})`);
  }
  const [inPrice, outPrice] = MODEL_PRICING_PER_MTOK[model] ?? UNKNOWN_MODEL_PRICING;
  const usd = (inputTokens / 1_000_000) * inPrice + (outputTokens / 1_000_000) * outPrice;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

export interface RecordLlmCostOptions {
  model: string;
  inputTokens: number;
  outputTokens: number;
  estUsd: number;
  articleId?: string | null;
}

/** Persist a single LLM invocation cost row to the `costs` table. */
export async function recordLlmCost(options: RecordLlmCostOptions): Promise<void> {
  await withTransaction((db) =>
    insertCost(db, { ...options, articleId: options.articleId ?? null }),
  );
}

/** Strip optional markdown code fences around JSON output. */
function extractJsonObject(rawText: string): string {
  const stripped = rawText.trim();
  const fenceMatch = /```(?:json)?\s*(\{.*\}|\[.*\])\s*```/s.exec(stripped);
  return fenceMatch?.[1] !== undefined ? fenceMatch[1].trim() : stripped;
}

/**
 * Invoke an OpenAI chat completion (with native JSON schema `response_format` when
 * `outputSchema` is provided) and return `{ output, usage }`.
 */
export async function callLlm(options: CallLlmOptions): Promise<LlmResult> {
  const { model, outputSchema = null, articleId = null } = options;
  if (!model) throw new Error("callLlm: model is required");

  const response = await getOpenaiClient().chat.completions.create({
    model,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: [
      { role: "system", content: options.systemPrompt },
      { role: "user", content: options.userInput },
    ],
    ...(outputSchema === null
      ? {}
      : {
          response_format: {
            type: "json_schema" as const,
            json_schema: { name: "output", schema: z.toJSONSchema(outputSchema) },
          },
        }),
  });

  const inputTokens = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;
  const usage: UsageRecord = {
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    est_usd: estimateLlmCostUsd(model, inputTokens, outputTokens),
    article_id: articleId,
  };

  if (options.persistCost) {
    await recordLlmCost({ model, inputTokens, outputTokens, estUsd: usage.est_usd, articleId });
  }

  const text = response.choices[0]?.message.content ?? "";
  if (outputSchema === null) return { output: text, usage };
  // Python validated `None` when there was no choice; JSON.parse("") throws the same way.
  return { output: outputSchema.parse(JSON.parse(extractJsonObject(text))), usage };
}
