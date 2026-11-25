/**
 * Integration tests for the evaluation suite against real Postgres:
 *
 * 1. `upsertEvalResult` persists `EvalResult` and updates `snapshots.confidence` from
 *    `NULL` to the calibrated composite score.
 * 2. `upsertEvalRun` persists multi-variant benchmark summaries (`eval_runs`).
 * 3. `kbEvalReport` (10th MCP tool) and `getLatestEvalReport` return taxonomy counts,
 *    pass rates, recent snapshot critiques, and the latest variant experiment run.
 */

import { describe, expect, test } from "bun:test";
import {
  getLatestEvalReport,
  getSnapshot,
  saveSnapshot,
  upsertEvalResult,
  upsertEvalRun,
} from "../../kb/db/queries";
import { evaluateTraceOffline, runBenchmarkVariants } from "../../kb/evals/metrics";
import * as tools from "../../kb/mcp/tools";
import { POSTGRES_AVAILABLE, useRollbackDb } from "./db";

const QUESTION = "How does Inngest memoize step outputs?";
const PASS_ANSWER = "Inngest memoizes every completed step output via ctx.step.run [1].";
const FAIL_ANSWER = "Inngest memoizes steps [1] and uses a 9-node Raft cluster [5].";

const RETRIEVED_SAMPLE = [
  {
    passage_id: "p-test-1",
    title: "Durable Execution with Inngest",
    author: "Miguel Otero Pedrido",
    publication: "the-neural-maze",
    url: "https://www.theneuralmaze.com/p/durable-harnesses",
    published_at: "2026-10-01T00:00:00+00:00",
    text: "Inngest memoizes every completed step output via ctx.step.run.",
    claim_id: "c-test-1",
    claim_text: "Inngest memoizes completed step outputs.",
    claim_type: "measurement",
    valid_to: null,
  },
];
const CITATIONS_SAMPLE = [
  {
    citation_idx: 1,
    passage_id: "p-test-1",
    title: "Durable Execution with Inngest",
    author: "Miguel Otero Pedrido",
    url: "https://www.theneuralmaze.com/p/durable-harnesses",
  },
];

describe.skipIf(!POSTGRES_AVAILABLE)("evals pipeline against Postgres", () => {
  const db = useRollbackDb();

  async function saveSampleSnapshot(snapshotId: string, answerText: string, latencyMs: number) {
    await saveSnapshot(db(), {
      snapshotId,
      question: QUESTION,
      answerText,
      citations: CITATIONS_SAMPLE,
      retrieved: RETRIEVED_SAMPLE,
      retrieverVariant: "hybrid_3way_rrf_k60",
      asOf: new Date("2026-10-01T00:00:00Z"),
      latencyMs,
    });
  }

  async function saveOfflineEval(snapshotId: string, answerText: string) {
    const result = evaluateTraceOffline({
      question: QUESTION,
      retrieved: RETRIEVED_SAMPLE,
      citations: CITATIONS_SAMPLE,
      answer_text: answerText,
    });
    await upsertEvalResult(db(), {
      snapshotId,
      deterministicPassed: Boolean(result.deterministic_passed),
      checks: result.checks,
      faithfulnessVerdict: String(result.faithfulness_verdict),
      faithfulnessCritique: String(result.faithfulness_critique),
      disagreementVerdict: String(result.disagreement_verdict),
      disagreementCritique: String(result.disagreement_critique),
      failureCodes: result.failure_codes,
      compositeScore: Number(result.composite_score),
    });
  }

  test("eval result updates snapshot confidence and surfaces in the MCP report", async () => {
    const snapPassId = "snap_eval_pass_01";
    const snapFailId = "snap_eval_fail_01";

    // 1. Save two snapshots (initially confidence=null)
    await saveSampleSnapshot(snapPassId, PASS_ANSWER, 120);
    await saveSampleSnapshot(snapFailId, FAIL_ANSWER, 145);
    const before = await getSnapshot(db(), snapPassId);
    expect(before).not.toBeNull();
    expect(before?.confidence).toBeNull();

    // 2. Evaluate both traces and persist to eval_results + snapshots.confidence
    await saveOfflineEval(snapPassId, PASS_ANSWER);
    await saveOfflineEval(snapFailId, FAIL_ANSWER);

    // 3. Persist a benchmark variant suite run
    const bench = runBenchmarkVariants();
    await upsertEvalRun(db(), {
      runId: "eval_run_integration_test",
      suiteName: bench.suite_name,
      variantsSummary: bench.variants_summary,
      caseResults: bench.case_results,
    });

    // 4. Verify snapshots.confidence was updated
    expect(Number((await getSnapshot(db(), snapPassId))?.confidence ?? 0)).toBe(1.0);
    expect(Number((await getSnapshot(db(), snapFailId))?.confidence ?? 0)).toBe(0.0);

    // 5. Verify kbEvalReport returns taxonomy counts and suite summary
    const report = await tools.kbEvalReport(10);
    expect(Number(report.total_evaluated_snapshots)).toBeGreaterThanOrEqual(2);
    const taxCounts = report.failure_taxonomy_counts as Record<string, number>;
    expect(taxCounts["FM-1"] ?? 0).toBeGreaterThanOrEqual(1);

    const latestSuite = report.latest_suite_run as Record<string, unknown> | null;
    expect(latestSuite).not.toBeNull();
    expect(latestSuite?.suite_name).toBe("golden_v1");
    expect(Object.keys(latestSuite?.variants_summary as object)).toContain("hybrid_3way_rrf_k60");

    const directReport = await getLatestEvalReport(db(), 10);
    expect(directReport.total_evaluated_snapshots).toBe(report.total_evaluated_snapshots);
  });
});
