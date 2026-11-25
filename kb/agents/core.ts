/**
 * Hand-written agent execution layer built directly on Inngest step primitives.
 *
 * No agent frameworks (LangChain, LangGraph, CrewAI) are used. Every LLM call is
 * wrapped in `step.run(stepId, ...)` so outputs are durably memoized by Inngest
 * and validated with zod.
 */

import type { z } from "zod";
import { callLlm, type LlmResult } from "./providers";

const DEFAULT_AGENT_MAX_TOKENS = 2048;

interface AgentSpec {
  name: string;
  role: string;
  system_prompt: string;
  model: string;
  max_tokens?: number;
}

/**
 * Declarative specification for a single-purpose agent role.
 *
 * A structured agent has an `output_schema` and yields `T`. A text agent has
 * `output_schema: null` and yields a string, so `null` is only allowed when `T` is `string`.
 */
export type Agent<T = string> = AgentSpec & {
  output_schema: z.ZodType<T> | (string extends T ? null : never);
};

/** The one part of the Inngest `step` object the agent layer needs (tests pass a fake). */
export interface StepRunner {
  run(id: string, fn: () => Promise<LlmResult>): Promise<unknown>;
}

export interface BoundedLoopOptions<T> {
  stepPrefix: string;
  shouldStop: (output: T, iteration: number) => boolean | Promise<boolean>;
  nextInput: (output: T, iteration: number) => string | Promise<string>;
  maxIterations?: number;
  maxUsd?: number;
  articleId?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate a memoized step output against the agent's schema (or stringify it). Pure. */
function parseAgentOutput<T>(agent: Agent<T>, raw: unknown): T {
  const schema = agent.output_schema;
  // `output_schema` is null only for text agents, where T is string (see `Agent`).
  if (schema === null) return String(raw) as T;
  return schema.parse(typeof raw === "string" ? JSON.parse(raw) : raw);
}

/**
 * Execute one LLM call inside `step.run(stepId, ...)` and return
 * `[parsedOutput, estUsd]` so bounded agent loops can enforce USD budgets.
 */
export async function runAgentWithUsage<T>(
  step: StepRunner,
  agent: Agent<T>,
  userInput: string,
  stepId: string,
  articleId: string | null = null,
): Promise<[T, number]> {
  if (!stepId) throw new Error(`runAgentWithUsage: empty step id for agent ${agent.name}`);
  const stepResult = await step.run(stepId, () =>
    callLlm({
      systemPrompt: agent.system_prompt,
      userInput,
      model: agent.model,
      maxTokens: agent.max_tokens ?? DEFAULT_AGENT_MAX_TOKENS,
      outputSchema: agent.output_schema,
      articleId,
    }),
  );

  if (!isRecord(stepResult)) return [parseAgentOutput(agent, stepResult), 0];
  const usage = stepResult.usage;
  const estUsd = isRecord(usage) && "est_usd" in usage ? Number(usage.est_usd) : 0;
  const rawOutput = "output" in stepResult ? stepResult.output : stepResult;
  return [parseAgentOutput(agent, rawOutput), estUsd];
}

/**
 * Execute one LLM call for `agent` inside `step.run(stepId, ...)` so its
 * output is durably memoized by Inngest and its token cost is captured by
 * `CostCaptureMiddleware`.
 */
export async function runAgent<T>(
  step: StepRunner,
  agent: Agent<T>,
  userInput: string,
  stepId: string,
  articleId: string | null = null,
): Promise<T> {
  const [output] = await runAgentWithUsage(step, agent, userInput, stepId, articleId);
  return output;
}

/** Execute a bounded multi-step agent loop with hard iteration and USD cost caps. */
export async function boundedLoop<T>(
  step: StepRunner,
  agent: Agent<T>,
  initialInput: string,
  options: BoundedLoopOptions<T>,
): Promise<T[]> {
  const { stepPrefix, shouldStop, nextInput, maxIterations = 3, maxUsd = 0.5 } = options;
  if (!Number.isInteger(maxIterations) || maxIterations < 0) {
    throw new Error(
      `boundedLoop: maxIterations must be a non-negative integer, got ${maxIterations}`,
    );
  }
  const outputs: T[] = [];
  let currentInput = initialInput;
  let accumulatedUsd = 0;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (accumulatedUsd >= maxUsd) break;

    const stepId = `${stepPrefix}-${iteration}`;
    const [result, stepUsd] = await runAgentWithUsage(
      step,
      agent,
      currentInput,
      stepId,
      options.articleId ?? null,
    );
    accumulatedUsd += stepUsd;
    outputs.push(result);

    if (accumulatedUsd >= maxUsd) break;
    if ((await shouldStop(result, iteration)) || iteration >= maxIterations) break;
    currentInput = await nextInput(result, iteration);
  }

  return outputs;
}
