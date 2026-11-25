/**
 * Unit tests for judge calibration (TPR & TNR) and retrieval variant metrics.
 *
 * Verifies Hamel Husain's binary judge alignment criteria and the self-contained
 * `evals/` fixtures without external network or database dependencies.
 */

import { expect, test } from "bun:test";
import { BinaryVerdict } from "../../kb/evals/judges";
import {
  computeMrr,
  computeRecallAtK,
  computeTprTnr,
  evaluateTraceOffline,
  loadLabeledTraces,
  type Prediction,
  runBenchmarkVariants,
} from "../../kb/evals/metrics";

test("BinaryVerdict schema requires a critique and a binary verdict", () => {
  const verdict = BinaryVerdict.parse({
    critique: "Verified that [1] directly supports the claim and matches claim_type.",
    verdict: "PASS",
    failure_code: "NONE",
  });
  expect(verdict.verdict).toBe("PASS");
  expect(verdict.failure_code).toBe("NONE");
  expect(verdict.critique.length).toBeGreaterThanOrEqual(10);
  expect(() => BinaryVerdict.parse({ critique: "too short", verdict: "PASS" })).toThrow();
  expect(() =>
    BinaryVerdict.parse({ critique: "long enough critique", verdict: "MAYBE" }),
  ).toThrow();
});

test("computeTprTnr detects rubber-stamp and aligned judges", () => {
  // A rubber-stamp judge that marks everything PASS has TNR=1.0 but TPR=0.0
  const rubberStamp: Prediction[] = [
    ["FAIL", "PASS", { trace_id: "t1" }],
    ["FAIL", "PASS", { trace_id: "t2" }],
    ["PASS", "PASS", { trace_id: "t3" }],
    ["PASS", "PASS", { trace_id: "t4" }],
  ];
  const badReport = computeTprTnr(rubberStamp, { minTpr: 0.9, minTnr: 0.9 });
  expect(badReport.tpr).toBe(0.0);
  expect(badReport.tnr).toBe(1.0);
  expect(badReport.aligned).toBe(false);
  expect(badReport.disagreements).toHaveLength(2);

  // A well-calibrated judge with 100% TPR and 100% TNR passes alignment
  const calibrated: Prediction[] = [
    ["FAIL", "FAIL", { trace_id: "t1" }],
    ["FAIL", "FAIL", { trace_id: "t2" }],
    ["PASS", "PASS", { trace_id: "t3" }],
    ["PASS", "PASS", { trace_id: "t4" }],
  ];
  const goodReport = computeTprTnr(calibrated, { minTpr: 0.9, minTnr: 0.9 });
  expect(goodReport.tpr).toBe(1.0);
  expect(goodReport.tnr).toBe(1.0);
  expect(goodReport.aligned).toBe(true);
  expect(goodReport.disagreements).toEqual([]);
});

test("labeled traces fixture calibrates above 90 percent TPR and TNR", () => {
  const traces = loadLabeledTraces();
  expect(traces).toHaveLength(20);

  const predictions: Prediction[] = traces.map((trace) => [
    String(trace.human_verdict),
    evaluateTraceOffline(trace).verdict,
    { trace_id: trace.trace_id },
  ]);

  const report = computeTprTnr(predictions, { minTpr: 0.9, minTnr: 0.9 });
  expect(report.human_passes).toBe(10);
  expect(report.human_fails).toBe(10);
  expect(report.tpr).toBeGreaterThanOrEqual(0.9);
  expect(report.tnr).toBeGreaterThanOrEqual(0.9);
  expect(report.aligned).toBe(true);
});

test("Recall@k and MRR calculations", () => {
  const retrieved = ["p-3", "p-1", "p-5", "p-2", "p-9"];
  const expected = ["p-1", "p-2"];
  expect(computeRecallAtK(retrieved, expected, 5)).toBe(1.0);
  expect(computeRecallAtK(retrieved, expected, 2)).toBe(0.5);
  // First relevant hit ("p-1") is at rank 2 -> MRR = 1/2 = 0.5
  expect(computeMrr(retrieved, expected, 5)).toBe(0.5);
  expect(computeMrr(retrieved, ["p-404"], 5)).toBe(0.0);
});

test("golden benchmark variant experiment proves the 3-way RRF lift", () => {
  const result = runBenchmarkVariants();
  const summary = result.variants_summary;
  expect(new Set(Object.keys(summary))).toEqual(
    new Set(["sparse_bm25", "dense_pgvector", "hybrid_2way_rrf_k60", "hybrid_3way_rrf_k60"]),
  );

  const sparseRec = Number(summary.sparse_bm25.recall_at_5);
  const denseRec = Number(summary.dense_pgvector.recall_at_5);
  const rrf2Rec = Number(summary.hybrid_2way_rrf_k60.recall_at_5);
  const rrf3Rec = Number(summary.hybrid_3way_rrf_k60.recall_at_5);

  // 3-way RRF beats or matches 2-way RRF, and both beat single-engine retrieval
  expect(rrf3Rec).toBeGreaterThanOrEqual(rrf2Rec);
  expect(rrf2Rec).toBeGreaterThan(sparseRec);
  expect(rrf2Rec).toBeGreaterThan(denseRec);
  expect(summary.hybrid_3way_rrf_k60.cross_pub_coverage).toBe(1.0);
});
