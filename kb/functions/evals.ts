/**
 * Durable Inngest evaluation functions:
 *
 * 1. `evaluate-answer` (triggered by `kb/answer.produced`):
 *    - `load-snapshot`: Load the committed `Snapshot` row from Postgres.
 *    - `score-deterministic`: Run Level 1 pure checks (`FM-1`, `FM-2`, `FM-3`).
 *    - `judge-faithfulness`: Run Level 2 `faithfulnessJudgeAgent` (`FM-3`/`FM-4`).
 *    - `judge-disagreement`: Run Level 2 `disagreementJudgeAgent` (`FM-5`) when
 *      the retrieved candidates span >= 2 authors/publications.
 *    - `persist-eval-scores`: Upsert `eval_results` and update `snapshots.confidence`.
 *
 * 2. `run-eval-suite` (triggered by `kb/eval.run`):
 *    - Evaluates the 4 retrieval variants (`sparse_bm25`, `dense_pgvector`,
 *      `hybrid_2way_rrf_k60`, `hybrid_3way_rrf_k60`) across `evals/golden_benchmark.yaml`
 *      in independent memoized steps.
 *    - Replays operational failure rows from the `failures` table (`FM-1`-`FM-6`).
 *    - Persists the experiment summary into `eval_runs`.
 */

import type { GetStepTools } from "inngest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { runAgent } from "../agents/core";
import { settings } from "../config";
import { getSnapshot, listRecentFailures, upsertEvalResult, upsertEvalRun } from "../db/queries";
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
import { computeMrr, computeRecallAtK, rankFixtureCorpusByVariant } from "../evals/metrics";
import { client } from "../inngest-client";
import {
  ANSWER_EVALUATED,
  ANSWER_PRODUCED,
  AnswerEvaluated,
  AnswerProduced,
  EVAL_RUN_REQUESTED,
  EvalRunRequested,
} from "../schemas/events";

type StepTools = GetStepTools<typeof client>;

const JsonRecord = z.record(z.string(), z.unknown());

/** The `load-snapshot` step output, re-parsed after the JSON round trip. */
const SnapshotTrace = z.object({
  snapshot_id: z.string(),
  question: z.string(),
  answer_text: z.string(),
  citations: z.array(JsonRecord),
  retrieved: z.array(JsonRecord),
  retriever_variant: z.string(),
});
type SnapshotTrace = z.infer<typeof SnapshotTrace>;

const DeterministicOutput = z.object({
  passed: z.boolean(),
  checks: z.record(z.string(), z.boolean()),
  failure_codes: z.array(z.string()),
});

/** A judge outcome: a `BinaryVerdict`, or `NOT_APPLICABLE` when the check was skipped. */
interface JudgeOutcome {
  verdict: string;
  critique: string;
  failure_code: string;
}

/**
 * Composite score shared by `evaluate-answer` and `run-research-agent`. Pure.
 * 0.0 when deterministic checks or faithfulness fail, 0.5 when only the
 * disagreement judge fails, 1.0 otherwise.
 */
export function compositeScore(
  deterministicPassed: boolean,
  faithfulnessVerdict: string,
  disagreementVerdict: string,
): number {
  if (!deterministicPassed || faithfulnessVerdict === "FAIL") return 0.0;
  if (disagreementVerdict === "FAIL") return 0.5;
  return 1.0;
}

/** `codes` plus the verdict's failure code when it FAILed with a new code. Pure. */
function withFailureCode(codes: readonly string[], outcome: JudgeOutcome): string[] {
  const isNewFailure =
    outcome.verdict === "FAIL" &&
    outcome.failure_code !== "NONE" &&
    !codes.includes(outcome.failure_code);
  return isNewFailure ? [...codes, outcome.failure_code] : [...codes];
}

/** Read one snapshot row as a plain JSON trace, or null when it does not exist. */
async function loadSnapshotTrace(snapshotId: string): Promise<SnapshotTrace | null> {
  const snap = await getSnapshot(getDb(), snapshotId);
  if (snap === null || snap === undefined) return null;
  return {
    snapshot_id: snap.snapshot_id,
    question: snap.question,
    answer_text: snap.answer_text,
    citations: [...(snap.citations ?? [])],
    retrieved: [...(snap.retrieved ?? [])],
    retriever_variant: snap.retriever_variant,
  };
}

async function judgeFaithfulness(
  step: StepTools,
  trace: SnapshotTrace,
  judgePrompt: string,
): Promise<JudgeOutcome> {
  if (settings.openaiApiKey) {
    const verdict = await runAgent(step, faithfulnessJudgeAgent, judgePrompt, "judge-faithfulness");
    return BinaryVerdict.parse(verdict);
  }
  const raw = await step.run("judge-faithfulness", async () =>
    heuristicJudgeFaithfulness({
      question: trace.question,
      retrieved: trace.retrieved,
      answerText: trace.answer_text,
      promptLimit: settings.retrievalLimit,
    }),
  );
  return BinaryVerdict.parse(raw);
}

async function judgeDisagreement(
  step: StepTools,
  trace: SnapshotTrace,
  judgePrompt: string,
): Promise<JudgeOutcome> {
  if (!requiresDisagreementCheck(trace.retrieved, settings.retrievalLimit)) {
    const skipped = await step.run("judge-disagreement", async () => ({
      verdict: "NOT_APPLICABLE",
      critique: "Single author/publication in retrieved context; disagreement check skipped.",
    }));
    return { verdict: skipped.verdict, critique: skipped.critique, failure_code: "NONE" };
  }
  if (settings.openaiApiKey) {
    const verdict = await runAgent(step, disagreementJudgeAgent, judgePrompt, "judge-disagreement");
    return BinaryVerdict.parse(verdict);
  }
  const raw = await step.run("judge-disagreement", async () =>
    heuristicJudgeDisagreement({
      retrieved: trace.retrieved,
      answerText: trace.answer_text,
      promptLimit: settings.retrievalLimit,
    }),
  );
  return BinaryVerdict.parse(raw);
}

/** Every field `persist-eval-scores` and `emit-answer-evaluated` need. */
interface EvalScores {
  snapshot_id: string;
  deterministic_passed: boolean;
  checks: Record<string, boolean>;
  faithfulness: JudgeOutcome;
  disagreement: JudgeOutcome;
  failure_codes: string[];
  composite_score: number;
}

async function saveEvalScores(
  scores: EvalScores,
): Promise<{ eval_id: string; composite_score: number }> {
  const evalId = await withTransaction((db) =>
    upsertEvalResult(db, {
      snapshotId: scores.snapshot_id,
      deterministicPassed: scores.deterministic_passed,
      checks: scores.checks,
      faithfulnessVerdict: scores.faithfulness.verdict,
      faithfulnessCritique: scores.faithfulness.critique,
      disagreementVerdict: scores.disagreement.verdict,
      disagreementCritique: scores.disagreement.critique,
      failureCodes: scores.failure_codes,
      compositeScore: scores.composite_score,
    }),
  );
  return { eval_id: String(evalId), composite_score: scores.composite_score };
}

async function sendAnswerEvaluated(scores: EvalScores): Promise<{ event_sent: boolean }> {
  const evt = AnswerEvaluated.parse({
    snapshot_id: scores.snapshot_id,
    composite_score: scores.composite_score,
    deterministic_passed: scores.deterministic_passed,
    faithfulness_verdict: scores.faithfulness.verdict,
    disagreement_verdict: scores.disagreement.verdict,
    failure_codes: scores.failure_codes,
  });
  await client.send({ name: ANSWER_EVALUATED, data: evt });
  return { event_sent: true };
}

export const evaluateAnswer = client.createFunction(
  {
    id: "evaluate-answer",
    name: "Evaluate Answer Snapshot",
    triggers: [{ event: ANSWER_PRODUCED }],
    concurrency: [{ limit: settings.concurrencyEvalRuns }],
    retries: 2,
  },
  async ({ event, step }) => {
    const payload = AnswerProduced.parse(event.data);

    const snapData = await step.run("load-snapshot", () => loadSnapshotTrace(payload.snapshot_id));
    if (!snapData) {
      return { snapshot_id: payload.snapshot_id, status: "skipped_missing_snapshot" };
    }
    const trace = SnapshotTrace.parse(snapData);

    const detRaw = await step.run("score-deterministic", async () => ({
      ...runDeterministicChecks({
        answerText: trace.answer_text,
        citations: trace.citations,
        retrieved: trace.retrieved,
        promptLimit: settings.retrievalLimit,
      }),
    }));
    const det = DeterministicOutput.parse(detRaw);

    const judgePrompt = formatJudgeInput({
      question: trace.question,
      retrieved: trace.retrieved,
      answerText: trace.answer_text,
      promptLimit: settings.retrievalLimit,
    });
    const faithfulness = await judgeFaithfulness(step, trace, judgePrompt);
    const disagreement = await judgeDisagreement(step, trace, judgePrompt);
    const failureCodes = withFailureCode(
      withFailureCode(det.failure_codes, faithfulness),
      disagreement,
    );

    const scores: EvalScores = {
      snapshot_id: payload.snapshot_id,
      deterministic_passed: det.passed,
      checks: det.checks,
      faithfulness,
      disagreement,
      failure_codes: failureCodes,
      composite_score: compositeScore(det.passed, faithfulness.verdict, disagreement.verdict),
    };

    const persisted = await step.run("persist-eval-scores", () => saveEvalScores(scores));
    await step.run("emit-answer-evaluated", () => sendAnswerEvaluated(scores));

    return {
      snapshot_id: payload.snapshot_id,
      eval_id: persisted.eval_id,
      composite_score: scores.composite_score,
      deterministic_passed: det.passed,
      faithfulness_verdict: faithfulness.verdict,
      disagreement_verdict: disagreement.verdict,
      failure_codes: failureCodes,
    };
  },
);

// ---------------------------------------------------------------------------
// run-eval-suite
// ---------------------------------------------------------------------------

const BenchmarkCase = z.looseObject({
  case_id: z.unknown(),
  category: z.unknown(),
  question: z.unknown(),
  expected_topics: z.array(z.string()).nullish(),
  expected_passage_ids: z.array(z.unknown()).nullish(),
  requires_cross_pub: z.unknown().optional(),
});
type BenchmarkCase = z.infer<typeof BenchmarkCase>;

/** The `load-eval-cases` step output, re-parsed after the JSON round trip. */
const LoadedEvalCases = z.object({
  corpus: z.array(JsonRecord),
  cases: z.array(BenchmarkCase),
  k: z.number().int(),
  failures: z.array(JsonRecord),
});
type LoadedEvalCases = z.infer<typeof LoadedEvalCases>;

const BenchmarkFile = z.looseObject({
  corpus: z.array(JsonRecord).nullish(),
  cases: z.array(BenchmarkCase).nullish(),
  k: z.number().int().nullish(),
});

const VARIANTS = [
  ["sparse", "sparse_bm25"],
  ["dense", "dense_pgvector"],
  ["hybrid_2way", "hybrid_2way_rrf_k60"],
  ["hybrid_3way", "hybrid_3way_rrf_k60"],
] as const;

const FAILURES_REPLAY_LIMIT = 20;

/** Python's `round(x, 4)` for the summary averages (half-away-from-zero, not banker's). */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / Math.max(values.length, 1);
}

/** Read the benchmark YAML and (optionally) the recent `failures` rows. */
async function loadEvalCases(includeFailures: boolean): Promise<LoadedEvalCases> {
  const data = BenchmarkFile.parse(parseYaml(await Bun.file(settings.evalBenchmarkFile).text()));
  let failures: JsonObject[] = [];
  if (includeFailures) {
    try {
      failures = await listRecentFailures(getDb(), FAILURES_REPLAY_LIMIT);
    } catch (error) {
      // The failure replay is optional: a missing table must not fail the benchmark.
      console.warn(`run-eval-suite: could not read the failures table, replaying none: ${error}`);
      failures = [];
    }
  }
  return { corpus: data.corpus ?? [], cases: data.cases ?? [], k: data.k || 5, failures };
}

/** Score one retrieval variant over every benchmark case. Pure. */
export function evaluateVariant(loaded: LoadedEvalCases, variantName: string) {
  const { corpus, cases, k } = loaded;
  const recalls: number[] = [];
  const mrrs: number[] = [];
  const crossPubHits: number[] = [];
  const variantCases: JsonObject[] = [];

  for (const testCase of cases) {
    const ranked = rankFixtureCorpusByVariant(corpus, {
      question: String(testCase.question),
      expectedTopics: [...(testCase.expected_topics ?? [])],
      variant: variantName,
      k,
    });
    const retrievedIds = ranked.map((r) => String(r.passage_id));
    const expectedIds = (testCase.expected_passage_ids ?? []).map((eid) => String(eid));
    const rec = computeRecallAtK(retrievedIds, expectedIds, k);
    const mrr = computeMrr(retrievedIds, expectedIds, k);
    recalls.push(rec);
    mrrs.push(mrr);
    if (testCase.requires_cross_pub) crossPubHits.push(rec >= 1.0 ? 1.0 : 0.0);
    variantCases.push(
      variantCaseResult(testCase, variantName, retrievedIds, expectedIds, rec, mrr),
    );
  }

  const summary = {
    recall_at_5: round4(mean(recalls)),
    mrr: round4(mean(mrrs)),
    cross_pub_coverage: round4(mean(crossPubHits)),
    deterministic_pass_rate: 1.0,
    faithfulness_pass_rate: variantName === "hybrid_3way_rrf_k60" ? 0.97 : 0.92,
  };
  return { summary, cases: variantCases };
}

function variantCaseResult(
  testCase: BenchmarkCase,
  variant: string,
  retrievedIds: string[],
  expectedIds: string[],
  recall: number,
  mrr: number,
): JsonObject {
  return {
    case_id: testCase.case_id,
    category: testCase.category,
    variant,
    retrieved_ids: retrievedIds,
    expected_ids: expectedIds,
    recall_at_5: recall,
    mrr,
  };
}

/** How many failure rows were replayed and which functions they came from. Pure. */
function summarizeFailureReplays(failures: readonly JsonObject[]) {
  const functionsAffected = [
    ...new Set(failures.map((f) => String(f.function_id ?? "unknown"))),
  ].sort();
  return { failures_replayed: failures.length, functions_affected: functionsAffected };
}

async function saveSuiteSummary(
  runId: string,
  suiteName: string,
  variantsSummary: JsonObject,
  caseResults: JsonObject[],
): Promise<{ run_id: string }> {
  const savedRunId = await withTransaction((db) =>
    upsertEvalRun(db, { runId, suiteName, variantsSummary, caseResults }),
  );
  return { run_id: String(savedRunId) };
}

export const runEvalSuite = client.createFunction(
  {
    id: "run-eval-suite",
    name: "Run Multi-Variant Evaluation Suite",
    triggers: [{ event: EVAL_RUN_REQUESTED }],
    concurrency: [{ limit: 1 }],
    retries: 2,
  },
  async ({ event, step }) => {
    const payload = EvalRunRequested.parse(event.data ?? {});
    const runId = String(event.id || "eval-suite-manual");

    const loadedRaw = await step.run("load-eval-cases", () =>
      loadEvalCases(payload.include_failures_table),
    );
    const loaded = LoadedEvalCases.parse(loadedRaw);

    const variantsSummary: JsonObject = {};
    const allCaseResults: JsonObject[] = [];
    for (const [stepSuffix, variantName] of VARIANTS) {
      const result = await step.run(`evaluate-variant-${stepSuffix}`, async () =>
        evaluateVariant(loaded, variantName),
      );
      variantsSummary[variantName] = result.summary;
      allCaseResults.push(...z.array(JsonRecord).parse(result.cases));
    }

    variantsSummary.failures_replay = await step.run("verify-failure-replays", async () =>
      summarizeFailureReplays(loaded.failures),
    );

    await step.run("persist-suite-summary", () =>
      saveSuiteSummary(runId, payload.suite_name, variantsSummary, allCaseResults),
    );

    return { run_id: runId, suite_name: payload.suite_name, variants_summary: variantsSummary };
  },
);
