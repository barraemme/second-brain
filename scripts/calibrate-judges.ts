/**
 * Calibrate the binary LLM judges against human-annotated gold traces
 * (`evals/labeled_traces.jsonl`), computing Hamel Husain's TPR (True Positive Rate
 * on failures) and TNR (True Negative Rate on passes).
 *
 * Usage:
 *     bun scripts/calibrate-judges.ts --mode offline
 *     bun scripts/calibrate-judges.ts --mode live
 */

import { parseArgs } from "node:util";
import type { Agent } from "../kb/agents/core";
import { callLlm } from "../kb/agents/providers";
import { settings } from "../kb/config";
import { type Row, runDeterministicChecks } from "../kb/evals/deterministic";
import {
  BinaryVerdict,
  disagreementJudgeAgent,
  faithfulnessJudgeAgent,
  formatJudgeInput,
  requiresDisagreementCheck,
} from "../kb/evals/judges";
import {
  asRows,
  type CalibrationReport,
  computeTprTnr,
  evaluateTraceOffline,
  loadLabeledTraces,
  type Prediction,
} from "../kb/evals/metrics";

const MODES = ["offline", "live"] as const;
type Mode = (typeof MODES)[number];

interface LiveTraceEval {
  verdict: "PASS" | "FAIL";
  failure_codes: string[];
  critique: string;
}

/** One live judge call (network: OpenAI). */
async function callJudge(agent: Agent<BinaryVerdict>, prompt: string): Promise<BinaryVerdict> {
  const resp = await callLlm({
    systemPrompt: agent.system_prompt,
    userInput: prompt,
    model: agent.model,
    maxTokens: agent.max_tokens,
    outputSchema: BinaryVerdict,
  });
  return BinaryVerdict.parse(resp.output);
}

async function evaluateTraceLive(trace: Row): Promise<LiveTraceEval> {
  const question = String(trace.question);
  const answerText = String(trace.answer_text);
  const retrieved = asRows(trace.retrieved);
  const citations = asRows(trace.citations);

  const det = runDeterministicChecks({ answerText, citations, retrieved });
  if (!det.passed) {
    return {
      verdict: "FAIL",
      failure_codes: det.failure_codes,
      critique: `Failed deterministic checks: ${JSON.stringify(det.failure_codes)}`,
    };
  }

  const prompt = formatJudgeInput({ question, retrieved, answerText });
  const faith = await callJudge(faithfulnessJudgeAgent, prompt);
  if (faith.verdict === "FAIL") {
    return { verdict: "FAIL", failure_codes: [faith.failure_code], critique: faith.critique };
  }

  if (requiresDisagreementCheck(retrieved)) {
    const dis = await callJudge(disagreementJudgeAgent, prompt);
    if (dis.verdict === "FAIL") {
      return { verdict: "FAIL", failure_codes: [dis.failure_code], critique: dis.critique };
    }
  }

  return { verdict: "PASS", failure_codes: [], critique: faith.critique };
}

/** Evaluate one trace, live (calls OpenAI) or offline, into a calibration prediction. */
async function predictTrace(trace: Row, mode: Mode): Promise<Prediction> {
  const humanVerdict = String(trace.human_verdict).toUpperCase();
  let verdict: string;
  let failureCodes: string[];
  let critique: string;
  if (mode === "live" && settings.openaiApiKey) {
    ({ verdict, failure_codes: failureCodes, critique } = await evaluateTraceLive(trace));
  } else {
    const res = evaluateTraceOffline(trace);
    [verdict, failureCodes, critique] = [res.verdict, res.failure_codes, res.faithfulness_critique];
  }
  return [
    humanVerdict,
    verdict.toUpperCase(),
    {
      trace_id: trace.trace_id,
      human_failure_code: trace.failure_code ?? "NONE",
      predicted_failure_codes: failureCodes,
      open_code_note: trace.open_code_note ?? "",
      judge_critique: critique,
    },
  ];
}

async function runCalibration(mode: Mode): Promise<CalibrationReport> {
  const predictions: Prediction[] = [];
  for (const trace of loadLabeledTraces()) {
    predictions.push(await predictTrace(trace, mode));
  }
  return computeTprTnr(predictions, { minTpr: settings.evalMinTpr, minTnr: settings.evalMinTnr });
}

function parseMode(): Mode {
  const { values } = parseArgs({
    options: {
      // 'offline' runs deterministic + heuristic judges; 'live' calls OpenAI.
      mode: { type: "string", default: "offline" },
    },
  });
  const mode = MODES.find((m) => m === values.mode);
  if (mode === undefined) {
    throw new Error(`--mode must be one of ${MODES.join(", ")}, got '${values.mode}'`);
  }
  return mode;
}

async function main(): Promise<void> {
  const report = await runCalibration(parseMode());
  console.info(JSON.stringify(report, null, 2));
  if (!report.aligned) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
