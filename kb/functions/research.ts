/**
 * Bounded research agent (`run-research-agent`).
 *
 * Triggered by `kb/research.requested`. Orchestrates a bounded multi-hop research
 * loop directly on Inngest durable steps (`step.run`):
 *
 * 1. `record-research-start`: Initialize the `research_runs` row with `status="running"`.
 * 2. `plan-subqueries`: Decompose the user's question via `queryPlannerAgent` (or
 *    deterministic fallback when `OPENAI_API_KEY` is unset).
 * 3. `hop-{i}-retrieve` & `hop-{i}-reflect` (bounded by `max_iterations` and `max_usd`):
 *    - Run 3-way hybrid retrieval (`BM25 + pgvector + Memgraph`) across the hop's sub-queries.
 *    - Deduplicate candidates into the cumulative evidence pool (`mergeHopCandidates`).
 *    - Stop immediately if `iteration >= max_iterations`, `total_cost_usd >= max_usd`, or
 *      `newly_added == 0` (convergence guardrail).
 *    - Otherwise invoke `coverageCriticAgent` to decide whether coverage is sufficient
 *      or to emit `followup_queries` for the next hop.
 * 4. `synthesize-report`: Synthesize a structured markdown report with inline `[k]` citations.
 * 5. `evaluate-report`: Run Level 1 deterministic checks (`FM-1`-`FM-3`) and
 *    Level 2 binary judges (`FM-4` faithfulness, `FM-5` disagreement coverage).
 * 6. `persist-research-run`: Persist the completed `research_runs` row and emit
 *    `kb/research.completed`.
 */

import type { GetStepTools } from "inngest";
import { z } from "zod";
import { callLlm } from "../agents/providers";
import {
  CoverageReflection,
  coverageCriticAgent,
  extractCitedEntries,
  formatEvidenceContext,
  heuristicPlanQueries,
  heuristicReflectCoverage,
  heuristicSynthesizeResearch,
  mergeHopCandidates,
  queryPlannerAgent,
  ResearchPlan,
  researchSynthesizerAgent,
} from "../agents/roles/researcher";
import { settings } from "../config";
import { upsertResearchRun } from "../db/queries";
import { getDb, withTransaction } from "../db/session";
import type { JsonObject } from "../db/types";
import { runDeterministicChecks } from "../evals/deterministic";
import {
  BinaryVerdict,
  disagreementJudgeAgent,
  faithfulnessJudgeAgent,
  formatJudgeInput,
  heuristicJudgeDisagreement,
  heuristicJudgeFaithfulness,
  requiresDisagreementCheck,
} from "../evals/judges";
import { client, usageFromOutput } from "../inngest-client";
import { hybridSearch } from "../retrieval/hybrid";
import {
  RESEARCH_COMPLETED,
  RESEARCH_REQUESTED,
  ResearchCompleted,
  ResearchRequested,
} from "../schemas/events";
import { compositeScore } from "./evals";

type StepTools = GetStepTools<typeof client>;

const JsonRecord = z.record(z.string(), z.unknown());
const HopRetrieval = z.object({ candidates: z.array(JsonRecord), queries: z.array(z.string()) });

/** Hard cap on hops, whatever the request asks for. */
const MAX_ITERATIONS_CAP = 5;
/** How many evidence passages the coverage critic sees. */
const CRITIC_EVIDENCE_LIMIT = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `usage.est_usd` of an LLM step output, or 0 when it carries none. Pure. */
function usageUsd(stepOutput: unknown): number {
  return usageFromOutput(stepOutput)?.est_usd ?? 0.0;
}

/** The `output` field of an LLM step result, or the result itself. Pure. */
function stepPayload(stepOutput: unknown): unknown {
  return isRecord(stepOutput) && "output" in stepOutput ? stepOutput.output : stepOutput;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Python's `repr(list_of_str)`, kept so the critic prompt text matches the Python version. */
function pyListRepr(values: readonly string[]): string {
  return `[${values.map((v) => `'${v}'`).join(", ")}]`;
}

// ---------------------------------------------------------------------------
// Step bodies
// ---------------------------------------------------------------------------

async function planSubqueries(question: string): Promise<unknown> {
  if (settings.openaiApiKey) {
    return callLlm({
      systemPrompt: queryPlannerAgent.system_prompt,
      userInput: `Research Question: ${question}`,
      model: queryPlannerAgent.model,
      maxTokens: queryPlannerAgent.max_tokens,
      outputSchema: ResearchPlan,
    });
  }
  const fallback = heuristicPlanQueries(question, {
    maxSubqueries: settings.researchMaxSubqueriesPerHop,
  });
  return { output: fallback };
}

async function retrieveHop(
  queries: string[],
): Promise<{ candidates: JsonObject[]; queries: string[] }> {
  const hopCandidates: JsonObject[] = [];
  for (const q of queries) {
    const [topK] = await hybridSearch(getDb(), q, settings.researchPassagesPerHop);
    hopCandidates.push(...topK);
  }
  return { candidates: hopCandidates, queries };
}

interface ReflectInput {
  question: string;
  prompt: string;
  executedQueries: string[];
  evidencePool: JsonObject[];
  targetTopics: string[];
  iteration: number;
}

async function reflectCoverage(input: ReflectInput): Promise<unknown> {
  if (settings.openaiApiKey) {
    return callLlm({
      systemPrompt: coverageCriticAgent.system_prompt,
      userInput: input.prompt,
      model: coverageCriticAgent.model,
      maxTokens: coverageCriticAgent.max_tokens,
      outputSchema: CoverageReflection,
    });
  }
  const fallback = heuristicReflectCoverage(
    input.question,
    input.executedQueries,
    input.evidencePool,
    input.targetTopics,
    input.iteration,
  );
  return { output: fallback };
}

async function synthesizeReport(question: string, topEvidence: JsonObject[]): Promise<unknown> {
  if (topEvidence.length === 0) {
    return { output: heuristicSynthesizeResearch(question, []) };
  }
  if (settings.openaiApiKey) {
    const synthInput =
      `Context Sources:\n${formatEvidenceContext(topEvidence)}\n\n` +
      `Research Question: ${question}\n\n` +
      "Write a comprehensive, inline-cited technical research report:";
    return callLlm({
      systemPrompt: researchSynthesizerAgent.system_prompt,
      userInput: synthInput,
      model: researchSynthesizerAgent.model,
      maxTokens: researchSynthesizerAgent.max_tokens,
      outputSchema: null,
    });
  }
  return { output: heuristicSynthesizeResearch(question, topEvidence) };
}

// ---------------------------------------------------------------------------
// Bounded hop loop
// ---------------------------------------------------------------------------

interface HopLimits {
  question: string;
  targetTopics: string[];
  maxIterations: number;
  maxUsd: number;
}

interface HopState {
  currentQueries: string[];
  executedQueries: string[];
  evidencePool: JsonObject[];
  hopsTrace: JsonObject[];
  iterationsUsed: number;
  stopReason: string;
  totalCostUsd: number;
}

interface HopStop {
  decision: string;
  rationale: string;
  reason: string;
}

/** Why the loop must stop after a retrieval, before paying for a reflection step; null to go on. Pure. */
function stopAfterRetrieval(
  iteration: number,
  newlyAdded: number,
  totalCostUsd: number,
  limits: HopLimits,
): HopStop | null {
  if (newlyAdded === 0 && iteration > 1) {
    return {
      decision: "stop_converged_zero_new_passages",
      rationale: "Hop produced zero new unique passages; halting loop.",
      reason: "converged",
    };
  }
  if (iteration >= limits.maxIterations) {
    return {
      decision: "stop_max_iterations_reached",
      rationale: `Reached max_iterations=${limits.maxIterations}.`,
      reason: "max_iterations_reached",
    };
  }
  if (totalCostUsd >= limits.maxUsd) {
    return {
      decision: "stop_budget_exceeded",
      rationale: `Accumulated cost $${totalCostUsd.toFixed(4)} reached max_usd=$${limits.maxUsd.toFixed(4)}.`,
      reason: "budget_exceeded",
    };
  }
  return null;
}

function buildCriticPrompt(limits: HopLimits, state: HopState): string {
  const topEvidence = state.evidencePool.slice(0, CRITIC_EVIDENCE_LIMIT);
  const topics = limits.targetTopics.length > 0 ? limits.targetTopics.join(", ") : "N/A";
  return (
    `Research Question: ${limits.question}\n` +
    `Target Topics: ${topics}\n` +
    `Executed Queries So Far: ${pyListRepr(state.executedQueries)}\n\n` +
    `Retrieved Evidence (${topEvidence.length} top passages):\n` +
    `${formatEvidenceContext(topEvidence)}`
  );
}

/** Run one `hop-{i}-reflect` step; returns the parsed reflection and its USD cost. */
async function runReflectStep(
  step: StepTools,
  iteration: number,
  limits: HopLimits,
  state: HopState,
): Promise<{ reflection: CoverageReflection; costUsd: number }> {
  const input: ReflectInput = {
    question: limits.question,
    prompt: buildCriticPrompt(limits, state),
    executedQueries: [...state.executedQueries],
    evidencePool: [...state.evidencePool],
    targetTopics: limits.targetTopics,
    iteration,
  };
  const reflectStep = await step.run(`hop-${iteration}-reflect`, () => reflectCoverage(input));
  return {
    reflection: CoverageReflection.parse(stepPayload(reflectStep)),
    costUsd: usageUsd(reflectStep),
  };
}

/** Why the loop must stop before a hop's retrieval; null to go on. Pure. */
function stopBeforeRetrieval(state: HopState, limits: HopLimits): string | null {
  if (state.totalCostUsd >= limits.maxUsd) return "budget_exceeded";
  if (state.currentQueries.length === 0) return "no_followup_queries";
  return null;
}

/**
 * Run hop `iteration`: retrieve, merge, then reflect unless a guardrail stops first.
 * Updates `state` (pool, trace, cost, next queries). Returns the stop reason, or null to go on.
 */
async function updateStateWithHop(
  step: StepTools,
  iteration: number,
  hopQueries: string[],
  limits: HopLimits,
  state: HopState,
): Promise<string | null> {
  const retrieval = await step.run(`hop-${iteration}-retrieve`, () => retrieveHop([...hopQueries]));
  state.executedQueries.push(...hopQueries);
  const candidates = HopRetrieval.parse(retrieval).candidates;
  const [pool, newlyAdded] = mergeHopCandidates(state.evidencePool, candidates);
  state.evidencePool = pool;
  const hopBase = {
    hop: iteration,
    queries: hopQueries,
    newly_added_passages: newlyAdded,
    cumulative_passages: pool.length,
  };

  // Convergence & budget checks before paying for a reflection LLM step
  const stop = stopAfterRetrieval(iteration, newlyAdded, state.totalCostUsd, limits);
  if (stop !== null) {
    const { decision, rationale } = stop;
    state.hopsTrace.push({ ...hopBase, decision, rationale, step_cost_usd: 0.0 });
    return stop.reason;
  }

  const { reflection, costUsd } = await runReflectStep(step, iteration, limits, state);
  state.totalCostUsd += costUsd;
  state.hopsTrace.push({
    ...hopBase,
    decision: reflection.is_sufficient ? "sufficient" : "continue",
    rationale: reflection.rationale,
    missing_aspects: reflection.missing_aspects,
    followup_queries: reflection.followup_queries,
    step_cost_usd: round6(costUsd),
  });
  if (reflection.is_sufficient || reflection.followup_queries.length === 0) {
    return "sufficient_coverage";
  }
  state.currentQueries = reflection.followup_queries.filter(
    (q) => !state.executedQueries.includes(q),
  );
  return null;
}

/** The bounded retrieval + reflection loop (at most `limits.maxIterations` hops). Updates and returns `state`. */
async function runResearchHops(
  step: StepTools,
  limits: HopLimits,
  state: HopState,
): Promise<HopState> {
  for (let iteration = 1; iteration <= limits.maxIterations; iteration++) {
    const early = stopBeforeRetrieval(state, limits);
    if (early !== null) {
      state.stopReason = early;
      break;
    }
    state.iterationsUsed = iteration;
    const hopQueries = state.currentQueries
      .slice(0, settings.researchMaxSubqueriesPerHop)
      .filter((q) => !state.executedQueries.includes(q));
    if (hopQueries.length === 0) {
      state.stopReason = "queries_exhausted";
      break;
    }
    const stopReason = await updateStateWithHop(step, iteration, hopQueries, limits, state);
    if (stopReason !== null) {
      state.stopReason = stopReason;
      break;
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// Report evaluation
// ---------------------------------------------------------------------------

interface ReportTrace {
  question: string;
  reportText: string;
  citations: JsonObject[];
  evidencePool: JsonObject[];
  promptLimit: number;
  stopReason: string;
}

interface JudgeResult {
  verdict: string;
  critique: string;
  failureCode: string;
  costUsd: number;
}

async function judgeReportFaithfulness(
  trace: ReportTrace,
  judgeInput: string,
): Promise<JudgeResult> {
  if (settings.openaiApiKey) {
    const res = await callLlm({
      systemPrompt: faithfulnessJudgeAgent.system_prompt,
      userInput: judgeInput,
      model: faithfulnessJudgeAgent.model,
      maxTokens: faithfulnessJudgeAgent.max_tokens,
      outputSchema: BinaryVerdict,
    });
    const v = BinaryVerdict.parse(res.output);
    return {
      verdict: v.verdict,
      critique: v.critique,
      failureCode: v.failure_code,
      costUsd: usageUsd(res),
    };
  }
  const v = heuristicJudgeFaithfulness({
    question: trace.question,
    retrieved: trace.evidencePool,
    answerText: trace.reportText,
    promptLimit: trace.promptLimit,
  });
  return { verdict: v.verdict, critique: v.critique, failureCode: v.failure_code, costUsd: 0.0 };
}

async function judgeReportDisagreement(
  trace: ReportTrace,
  judgeInput: string,
): Promise<JudgeResult> {
  if (!requiresDisagreementCheck(trace.evidencePool, trace.promptLimit)) {
    return {
      verdict: "NOT_APPLICABLE",
      critique: "Single author/publication in retrieved evidence pool.",
      failureCode: "NONE",
      costUsd: 0.0,
    };
  }
  if (settings.openaiApiKey) {
    const res = await callLlm({
      systemPrompt: disagreementJudgeAgent.system_prompt,
      userInput: judgeInput,
      model: disagreementJudgeAgent.model,
      maxTokens: disagreementJudgeAgent.max_tokens,
      outputSchema: BinaryVerdict,
    });
    const v = BinaryVerdict.parse(res.output);
    return {
      verdict: v.verdict,
      critique: v.critique,
      failureCode: v.failure_code,
      costUsd: usageUsd(res),
    };
  }
  const v = heuristicJudgeDisagreement({
    retrieved: trace.evidencePool,
    answerText: trace.reportText,
    promptLimit: trace.promptLimit,
  });
  return { verdict: v.verdict, critique: v.critique, failureCode: v.failure_code, costUsd: 0.0 };
}

/** Body of the `evaluate-report` step: deterministic checks plus both binary judges. */
async function evaluateReport(trace: ReportTrace) {
  const det = runDeterministicChecks({
    answerText: trace.reportText,
    citations: trace.citations,
    retrieved: trace.evidencePool,
    promptLimit: trace.promptLimit,
  });
  const failureCodes = [...det.failure_codes];
  const judgeInput = formatJudgeInput({
    question: trace.question,
    retrieved: trace.evidencePool,
    answerText: trace.reportText,
    promptLimit: trace.promptLimit,
  });

  const faith = await judgeReportFaithfulness(trace, judgeInput);
  if (faith.verdict === "FAIL" && faith.failureCode !== "NONE") {
    const codePrefix = faith.failureCode.split(":")[0] ?? faith.failureCode;
    if (!failureCodes.includes(codePrefix)) failureCodes.push(codePrefix);
  }
  const dis = await judgeReportDisagreement(trace, judgeInput);
  if (dis.verdict === "FAIL" && !failureCodes.includes("FM-5")) failureCodes.push("FM-5");

  return {
    deterministic_passed: det.passed,
    checks: det.checks,
    faithfulness_verdict: faith.verdict,
    faithfulness_critique: faith.critique,
    disagreement_verdict: dis.verdict,
    disagreement_critique: dis.critique,
    failure_codes: failureCodes,
    composite_score: compositeScore(det.passed, faith.verdict, dis.verdict),
    stop_reason: trace.stopReason,
    eval_cost_usd: faith.costUsd + dis.costUsd,
  };
}

const EvalSummary = z.looseObject({
  composite_score: z.number(),
  failure_codes: z.array(z.string()),
  eval_cost_usd: z.number().nullish(),
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface ResearchRunRow {
  researchId: string;
  eventId: string | null;
  question: string;
  status: string;
  plan: string[];
  hops: JsonObject[];
  reportText: string | null;
  citations: JsonObject[];
  retrieved: JsonObject[];
  evalSummary: JsonObject;
  confidence: number | null;
  iterationsUsed: number;
  totalCostUsd: number;
  latencyMs: number;
  completedAt: Date | null;
}

async function saveResearchRun(row: ResearchRunRow): Promise<void> {
  await withTransaction((db) => upsertResearchRun(db, row));
}

/** The `research_runs` row at `record-research-start`: running, nothing produced yet. */
function startedRow(researchId: string, eventId: string | null, question: string): ResearchRunRow {
  return {
    researchId,
    eventId,
    question,
    status: "running",
    plan: [],
    hops: [],
    reportText: null,
    citations: [],
    retrieved: [],
    evalSummary: {},
    confidence: null,
    iterationsUsed: 0,
    totalCostUsd: 0.0,
    latencyMs: 0,
    completedAt: null,
  };
}

/** `max_iterations` clamped to 1..5 (0/null -> the configured default). Pure. */
export function clampMaxIterations(requested: number | null | undefined): number {
  return Math.min(Math.max(requested || settings.researchMaxIterations, 1), MAX_ITERATIONS_CAP);
}

export const runResearchAgent = client.createFunction(
  {
    id: "run-research-agent",
    name: "Run Bounded Research Agent",
    triggers: [{ event: RESEARCH_REQUESTED }],
    concurrency: [{ limit: settings.concurrencyResearchRuns }],
    retries: 2,
  },
  async ({ event, step }) => {
    const startClock = performance.now();
    const payload = ResearchRequested.parse(event.data);
    const maxIterations = clampMaxIterations(payload.max_iterations);
    const maxUsd = payload.max_usd ?? settings.researchMaxUsd;
    const eventId = event.id ? String(event.id) : null;

    await step.run("record-research-start", async () => {
      await saveResearchRun(startedRow(payload.research_id, eventId, payload.question));
      return { research_id: payload.research_id, status: "running" };
    });

    // Step 1: Decompose question into initial sub-queries
    const planStep = await step.run("plan-subqueries", () => planSubqueries(payload.question));
    const planObj = ResearchPlan.parse(stepPayload(planStep));
    const initialQueries = planObj.subqueries.slice(0, settings.researchMaxSubqueriesPerHop);
    const limits: HopLimits = {
      question: payload.question,
      targetTopics: [...planObj.target_topics],
      maxIterations,
      maxUsd,
    };

    // Step 2..N: Bounded retrieval + reflection hops
    const hops = await runResearchHops(step, limits, {
      currentQueries: [...initialQueries],
      executedQueries: [],
      evidencePool: [],
      hopsTrace: [],
      iterationsUsed: 0,
      stopReason: "completed",
      totalCostUsd: usageUsd(planStep),
    });

    const report = await synthesizeAndEvaluate(step, payload.question, hops);
    const finalRow: ResearchRunRow = {
      ...startedRow(payload.research_id, eventId, payload.question),
      status: hops.stopReason === "budget_exceeded" ? "budget_exceeded" : "completed",
      plan: initialQueries,
      hops: hops.hopsTrace,
      reportText: report.reportText,
      citations: report.citations,
      retrieved: hops.evidencePool,
      evalSummary: report.evalSummary,
      confidence: report.evalSummary.composite_score,
      iterationsUsed: hops.iterationsUsed,
      totalCostUsd: round6(report.totalCostUsd),
      latencyMs: Math.trunc(performance.now() - startClock),
      completedAt: new Date(),
    };
    return saveAndAnnounceResearchRun(step, finalRow, report.evalSummary.failure_codes);
  },
);

/** Step N+3: persist the completed research run, then emit `kb/research.completed`. */
async function saveAndAnnounceResearchRun(
  step: StepTools,
  row: ResearchRunRow,
  failureCodes: string[],
) {
  const summary = {
    research_id: row.researchId,
    status: row.status,
    iterations_used: row.iterationsUsed,
    total_cost_usd: row.totalCostUsd,
    confidence: row.confidence ?? 0.0,
  };
  const persisted = await step.run("persist-research-run", async () => {
    await saveResearchRun(row);
    return summary;
  });
  const completed = ResearchCompleted.parse({ ...summary, failure_codes: failureCodes });
  await step.sendEvent("emit-research-completed", { name: RESEARCH_COMPLETED, data: completed });
  return persisted;
}

/** Steps N+1 and N+2: synthesize the cited report, then evaluate it. Adds both costs. */
async function synthesizeAndEvaluate(step: StepTools, question: string, hops: HopState) {
  // Step N+1: Synthesize the final cited research report
  const promptLimit = Math.max(settings.retrievalLimit * 2, 8);
  const topEvidence = hops.evidencePool.slice(0, promptLimit);
  const synthStep = await step.run("synthesize-report", () =>
    synthesizeReport(question, topEvidence),
  );
  const reportText = String(stepPayload(synthStep));
  const citations = extractCitedEntries(reportText, topEvidence);

  // Step N+2: Evaluate the report with deterministic checks & binary judges
  const trace: ReportTrace = {
    question,
    reportText,
    citations,
    evidencePool: hops.evidencePool,
    promptLimit,
    stopReason: hops.stopReason,
  };
  const evalSummary = EvalSummary.parse(
    await step.run("evaluate-report", () => evaluateReport(trace)),
  );
  const totalCostUsd = hops.totalCostUsd + usageUsd(synthStep) + (evalSummary.eval_cost_usd || 0.0);
  return { reportText, citations, evalSummary, totalCostUsd };
}
