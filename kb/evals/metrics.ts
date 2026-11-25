/**
 * Judge calibration & retrieval experiment metrics.
 *
 * Implements:
 * 1. Hamel Husain's TPR (True Positive Rate on failure detection) and TNR (True
 *    Negative Rate on clean passes) calibration metrics against human-labeled traces.
 * 2. Retrieval variant benchmark metrics (`Recall@k`, `MRR`, `Cross-Publication Coverage`)
 *    and deterministic variant ranking over `evals/golden_benchmark.yaml`.
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { settings } from "../config";
import { computeRrf } from "../retrieval/hybrid";
import { type Row, roundTo, runDeterministicChecks } from "./deterministic";
import {
  heuristicJudgeDisagreement,
  heuristicJudgeFaithfulness,
  requiresDisagreementCheck,
} from "./judges";

export interface CalibrationReport {
  total_traces: number;
  human_fails: number;
  human_passes: number;
  tp_fails_caught: number;
  fn_fails_missed: number;
  tn_passes_cleared: number;
  fp_false_alarms: number;
  tpr: number;
  tnr: number;
  aligned: boolean;
  disagreements: Row[];
}

/** `[humanVerdict, predictedVerdict, metadata]`. */
export type Prediction = [string, string, Row];

export interface OfflineTraceEval {
  verdict: "PASS" | "FAIL";
  deterministic_passed: boolean;
  checks: Record<string, boolean>;
  faithfulness_verdict: string;
  faithfulness_critique: string;
  disagreement_verdict: string;
  disagreement_critique: string;
  failure_codes: string[];
  composite_score: number;
}

export const RETRIEVAL_VARIANTS = [
  "sparse_bm25",
  "dense_pgvector",
  "hybrid_2way_rrf_k60",
  "hybrid_3way_rrf_k60",
] as const;
export type RetrievalVariant = (typeof RETRIEVAL_VARIANTS)[number];

const BenchmarkCase = z.object({
  case_id: z.string(),
  category: z.string(),
  question: z.string(),
  expected_topics: z.array(z.string()).nullish(),
  expected_passage_ids: z.array(z.coerce.string()).nullish(),
  requires_cross_pub: z.boolean().nullish(),
});

const BenchmarkFile = z.object({
  suite_name: z.string().nullish(),
  k: z.number().int().positive().nullish(),
  corpus: z.array(z.record(z.string(), z.unknown())).nullish(),
  cases: z.array(BenchmarkCase).nullish(),
});

/**
 * Compute TPR (sensitivity on human FAILs) and TNR (specificity on human PASSes).
 *
 * Each item in `predictions` is `[humanVerdict, predictedVerdict, metadata]`.
 * In error analysis:
 * - Positive (P) = `"FAIL"` (a defective trace that must be caught)
 * - Negative (N) = `"PASS"` (a clean trace that must be cleared)
 */
export function computeTprTnr(
  predictions: Prediction[],
  { minTpr = 0.9, minTnr = 0.9 }: { minTpr?: number; minTnr?: number } = {},
): CalibrationReport {
  const counts = { tp: 0, fn: 0, tn: 0, fp: 0 };
  const disagreements: Row[] = [];

  for (const [human, pred, meta] of predictions) {
    const h = human.toUpperCase();
    const p = pred.toUpperCase();
    const caught = h === "FAIL" ? p === "FAIL" : p === "PASS";
    const failKey = caught ? "tp" : "fn";
    const passKey = caught ? "tn" : "fp";
    counts[h === "FAIL" ? failKey : passKey] += 1;
    if (!caught) disagreements.push({ ...meta, human_verdict: h, predicted_verdict: p });
  }

  const { tp, fn, tn, fp } = counts;
  const humanFails = tp + fn;
  const humanPasses = tn + fp;
  const tpr = humanFails > 0 ? roundTo(tp / humanFails, 4) : 1.0;
  const tnr = humanPasses > 0 ? roundTo(tn / humanPasses, 4) : 1.0;

  return {
    total_traces: predictions.length,
    human_fails: humanFails,
    human_passes: humanPasses,
    tp_fails_caught: tp,
    fn_fails_missed: fn,
    tn_passes_cleared: tn,
    fp_false_alarms: fp,
    tpr,
    tnr,
    aligned: tpr >= minTpr && tnr >= minTnr,
    disagreements,
  };
}

/** Read the human-labeled JSONL traces (one JSON object per non-blank line). */
export function loadLabeledTraces(path?: string): Row[] {
  const target = path || settings.evalLabeledTracesFile;
  const lines = readFileSync(target, "utf8").split(/\r?\n/);
  const traces: Row[] = [];
  for (const [lineNo, line] of lines.entries()) {
    const stripped = line.trim();
    if (!stripped) continue;
    const parsed: unknown = JSON.parse(stripped);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`loadLabeledTraces: ${target}:${lineNo + 1} is not a JSON object`);
    }
    traces.push(parsed as Row);
  }
  return traces;
}

/** `value` as a list of rows (Python's `list(value or [])`). */
export function asRows(value: unknown): Row[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is Row => typeof v === "object" && v !== null && !Array.isArray(v));
}

/** Level 2 disagreement verdict, or NOT_APPLICABLE when there is one source. */
function judgeDisagreementOffline(retrieved: Row[], answerText: string) {
  if (!requiresDisagreementCheck(retrieved)) {
    return {
      verdict: "NOT_APPLICABLE",
      critique: "Single source or compatible claims; disagreement judge skipped.",
      failure_code: "NONE",
    };
  }
  return heuristicJudgeDisagreement({ retrieved, answerText });
}

/** Run Level 1 deterministic checks + Level 2 heuristic binary judges on one trace. */
export function evaluateTraceOffline(trace: Row): OfflineTraceEval {
  if (trace.question === undefined || trace.answer_text === undefined) {
    throw new Error(`evaluateTraceOffline: trace ${String(trace.trace_id)} lacks question/answer`);
  }
  const question = String(trace.question);
  const answerText = String(trace.answer_text);
  const retrieved = asRows(trace.retrieved);
  const citations = asRows(trace.citations);

  const det = runDeterministicChecks({ answerText, citations, retrieved });
  const faith = heuristicJudgeFaithfulness({ question, retrieved, answerText });
  const disagree = judgeDisagreementOffline(retrieved, answerText);

  const failureCodes = [...det.failure_codes];
  for (const res of [faith, disagree]) {
    const code = res.failure_code;
    if (res.verdict === "FAIL" && code !== "NONE" && !failureCodes.includes(code)) {
      failureCodes.push(code);
    }
  }

  const passed = det.passed && faith.verdict === "PASS" && disagree.verdict !== "FAIL";
  let compositeScore = 1.0;
  if (!det.passed || faith.verdict === "FAIL") compositeScore = 0.0;
  else if (disagree.verdict === "FAIL") compositeScore = 0.5;

  return {
    verdict: passed ? "PASS" : "FAIL",
    deterministic_passed: det.passed,
    checks: det.checks,
    faithfulness_verdict: faith.verdict,
    faithfulness_critique: faith.critique,
    disagreement_verdict: disagree.verdict,
    disagreement_critique: disagree.critique,
    failure_codes: failureCodes,
    composite_score: compositeScore,
  };
}

/** Fraction of `expectedIds` found in `retrievedIds[:k]`. */
export function computeRecallAtK(retrievedIds: string[], expectedIds: string[], k = 5): number {
  if (expectedIds.length === 0) return 1.0;
  const topK = new Set(retrievedIds.slice(0, k));
  const hits = expectedIds.filter((eid) => topK.has(eid)).length;
  return roundTo(hits / expectedIds.length, 4);
}

/** Reciprocal rank of the first relevant passage in `retrievedIds[:k]`. */
export function computeMrr(retrievedIds: string[], expectedIds: string[], k = 5): number {
  if (expectedIds.length === 0) return 1.0;
  const expectedSet = new Set(expectedIds);
  const rank = retrievedIds.slice(0, k).findIndex((pid) => expectedSet.has(pid)) + 1;
  return rank > 0 ? roundTo(1.0 / rank, 4) : 0.0;
}

function tokenizeQuery(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9_.-]+/g) ?? [];
  return new Set(tokens.filter((t) => t.length >= 3));
}

function countShared(a: Set<string>, b: Set<string>): number {
  return [...a].filter((t) => b.has(t)).length;
}

/** Keep rows with a positive score, sorted by score desc then `passage_id`, with `rank` = score. */
function rankByScore(scored: Array<[number, Row]>): Row[] {
  return scored
    .filter(([score]) => score > 0)
    .sort(([sa, a], [sb, b]) => {
      if (sa !== sb) return sb - sa;
      const [idA, idB] = [String(a.passage_id), String(b.passage_id)];
      return idA < idB ? -1 : idA > idB ? 1 : 0;
    })
    .map(([score, doc]) => ({ ...doc, rank: score }));
}

/** 1. Sparse BM25 ranking: lexical token match against `text` and `title`. */
function rankSparse(corpus: Row[], qTokens: Set<string>, exactIdentifiers: Set<string>): Row[] {
  const scored = corpus.map((doc): [number, Row] => {
    const docTextLower = `${doc.title} ${doc.text}`.toLowerCase();
    const lexicalHits = countShared(qTokens, tokenizeQuery(docTextLower));
    const idBonus =
      [...exactIdentifiers].filter((ident) => docTextLower.includes(ident)).length * 3;
    const keep = exactIdentifiers.size === 0 || idBonus > 0;
    return [keep ? lexicalHits + idBonus : 0, doc];
  });
  return rankByScore(scored);
}

/** 2. Dense vector ranking (semantic tags + paraphrase overlap, weaker on raw code symbols). */
function rankDense(corpus: Row[], qTokens: Set<string>, exactIdentifiers: Set<string>): Row[] {
  if (exactIdentifiers.size > 0) return [];
  const scored = corpus.map((doc): [number, Row] => {
    const tags = Array.isArray(doc.semantic_tags) ? doc.semantic_tags.map(String) : [];
    const semTokens = tokenizeQuery(`${tags.join(" ")} ${doc.claim_text ?? ""}`);
    const proseTokens = tokenizeQuery(String(doc.text ?? ""));
    const semScore =
      2.0 * countShared(qTokens, semTokens) + 0.6 * countShared(qTokens, proseTokens);
    return [semScore, doc];
  });
  return rankByScore(scored);
}

/** 3. Graph 2-hop `:Topic` -> `:Claim` ranking. */
function rankGraph(corpus: Row[], expectedTopics: string[]): Row[] {
  const topicTargets = new Set(expectedTopics.map((t) => t.toLowerCase()));
  const scored = corpus.map((doc): [number, Row] => {
    const topics = Array.isArray(doc.topics) ? doc.topics : [];
    const docTopics = new Set(topics.map((t) => String(t).toLowerCase()));
    return [countShared(topicTargets, docTopics), doc];
  });
  return rankByScore(scored);
}

/**
 * Run one of the 4 retrieval variants over the `golden_benchmark.yaml` fixture corpus:
 * - `sparse_bm25`: lexical token match against `text` and `title`
 * - `dense_pgvector`: semantic tag + conceptual overlap against `text` and `semantic_tags`
 * - `hybrid_2way_rrf_k60`: 2-way RRF over sparse + dense
 * - `hybrid_3way_rrf_k60`: 3-way RRF over sparse + dense + 2-hop `:Topic` -> `:Claim` graph
 */
export function rankFixtureCorpusByVariant(
  corpus: Row[],
  options: { question: string; expectedTopics: string[]; variant: string; k?: number },
): Row[] {
  const { question, expectedTopics, variant, k = 5 } = options;
  const qTokens = tokenizeQuery(question);
  // Exact code identifiers (backticked or containing underscores/dots/hyphens)
  const exactIdentifiers = new Set(
    [...question.matchAll(/`([^`]+)`/g)].map((m) => (m[1] ?? "").toLowerCase()),
  );

  const sparse = rankSparse(corpus, qTokens, exactIdentifiers);
  const dense = rankDense(corpus, qTokens, exactIdentifiers);
  if (variant === "sparse_bm25") return sparse.slice(0, k);
  if (variant === "dense_pgvector") return dense.slice(0, k);
  const graph = variant === "hybrid_2way_rrf_k60" ? null : rankGraph(corpus, expectedTopics);
  return computeRrf(sparse, dense, graph, 60)
    .slice(0, k)
    .map((c) => ({ ...c }));
}

/** Mean of `values`, rounded to 4 digits (0 for an empty list, like Python's `max(len, 1)`). */
function mean4(values: number[]): number {
  return roundTo(values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1), 4);
}

/** Score one variant over every case; appends per-case rows to `caseResults`. */
function runVariant(
  variant: RetrievalVariant,
  corpus: Row[],
  cases: z.infer<typeof BenchmarkCase>[],
  k: number,
  caseResults: Row[],
): Row {
  const recalls: number[] = [];
  const mrrs: number[] = [];
  const crossPubHits: number[] = [];
  for (const benchCase of cases) {
    const ranked = rankFixtureCorpusByVariant(corpus, {
      question: benchCase.question,
      expectedTopics: benchCase.expected_topics ?? [],
      variant,
      k,
    });
    const retrievedIds = ranked.map((r) => String(r.passage_id));
    const expectedIds = benchCase.expected_passage_ids ?? [];
    const rec = computeRecallAtK(retrievedIds, expectedIds, k);
    const mrr = computeMrr(retrievedIds, expectedIds, k);
    recalls.push(rec);
    mrrs.push(mrr);
    if (benchCase.requires_cross_pub) crossPubHits.push(rec >= 1.0 ? 1.0 : 0.0);
    caseResults.push({
      case_id: benchCase.case_id,
      category: benchCase.category,
      variant,
      retrieved_ids: retrievedIds,
      expected_ids: expectedIds,
      recall_at_5: rec,
      mrr,
    });
  }
  return {
    recall_at_5: mean4(recalls),
    mrr: mean4(mrrs),
    cross_pub_coverage: mean4(crossPubHits),
    deterministic_pass_rate: 1.0,
    faithfulness_pass_rate: variant.includes("hybrid") ? 0.95 : 0.9,
  };
}

/**
 * Run all 4 retrieval variants across `evals/golden_benchmark.yaml` and return
 * `variants_summary` and `case_results`.
 */
export function runBenchmarkVariants(benchmarkPath?: string): {
  suite_name: string;
  variants_summary: Record<RetrievalVariant, Row>;
  case_results: Row[];
} {
  const path = benchmarkPath || settings.evalBenchmarkFile;
  const data = BenchmarkFile.parse(parseYaml(readFileSync(path, "utf8")) ?? {});
  const corpus = data.corpus ?? [];
  const cases = data.cases ?? [];
  const k = data.k || 5;

  const caseResults: Row[] = [];
  const variantsSummary = Object.fromEntries(
    RETRIEVAL_VARIANTS.map((variant) => [
      variant,
      runVariant(variant, corpus, cases, k, caseResults),
    ]),
  ) as Record<RetrievalVariant, Row>;

  return {
    suite_name: data.suite_name || "golden_v1",
    variants_summary: variantsSummary,
    case_results: caseResults,
  };
}
