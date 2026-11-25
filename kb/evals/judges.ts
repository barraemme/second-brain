/**
 * Level 2 narrow binary LLM judges (`PASS` / `FAIL` + mandatory `critique`).
 *
 * Follows Hamel Husain's LLM-as-a-Judge methodology:
 * 1. No 1-5 Likert scales. Every judge is a strict binary classifier (`PASS` or `FAIL`).
 * 2. `critique` comes first in the schema so the model reasons over the trace before
 *    emitting `verdict`.
 * 3. Separate judges per failure mode (`faithfulnessJudgeAgent` for FM-3/FM-4,
 *    `disagreementJudgeAgent` for FM-5) so evaluation criteria never bleed together.
 * 4. Deterministic heuristic fallback when `OPENAI_API_KEY` is unset, allowing
 *    offline calibration and CI tests to run without external API keys.
 */

import { z } from "zod";
import type { Agent } from "../agents/core";
import {
  DISAGREEMENT_JUDGE_SYSTEM_PROMPT,
  FAITHFULNESS_JUDGE_SYSTEM_PROMPT,
} from "../agents/prompts";
import { settings } from "../config";
import { extractInlineCitationIndices, isAbstainAnswer, type Row } from "./deterministic";

export const VerdictLabel = z.enum(["PASS", "FAIL"]);
export type VerdictLabel = z.infer<typeof VerdictLabel>;
export const JudgeFailureCode = z.enum(["NONE", "FM-3", "FM-4", "FM-5"]);
export type JudgeFailureCode = z.infer<typeof JudgeFailureCode>;

/** Hamel Husain binary judge output: mandatory critique first, binary verdict second. */
export const BinaryVerdict = z.object({
  critique: z
    .string()
    .min(10)
    .describe(
      "Step-by-step verification comparing each sentence and citation in the " +
        "answer against the retrieved passages and claim types.",
    ),
  verdict: VerdictLabel.describe(
    "Strict binary outcome: PASS only if zero violations exist, otherwise FAIL.",
  ),
  failure_code: JudgeFailureCode.default("NONE"),
});
export type BinaryVerdict = z.infer<typeof BinaryVerdict>;

export const faithfulnessJudgeAgent: Agent<BinaryVerdict> = {
  name: "faithfulness-judge",
  role: "Binary Faithfulness & Epistemic Attribution Judge",
  system_prompt: FAITHFULNESS_JUDGE_SYSTEM_PROMPT,
  model: settings.evalJudgeModel,
  output_schema: BinaryVerdict,
  max_tokens: settings.evalJudgeMaxTokens,
};

export const disagreementJudgeAgent: Agent<BinaryVerdict> = {
  name: "disagreement-judge",
  role: "Binary Cross-Publication Disagreement Judge",
  system_prompt: DISAGREEMENT_JUDGE_SYSTEM_PROMPT,
  model: settings.evalJudgeModel,
  output_schema: BinaryVerdict,
  max_tokens: settings.evalJudgeMaxTokens,
};

export interface JudgeInputOptions {
  question: string;
  retrieved: Row[];
  answerText: string;
  promptLimit?: number;
}

/** Python's `str(value).strip().lower()`. */
function normalizedKey(value: unknown): string {
  return String(value).trim().toLowerCase();
}

/** Return true if the top retrieved candidates span >= 2 distinct authors or publications. */
export function requiresDisagreementCheck(retrieved: Row[], promptLimit = 5): boolean {
  const top = retrieved.slice(0, promptLimit);
  const authors = new Set(
    top
      .filter((r) => r.author && normalizedKey(r.author) !== "unknown")
      .map((r) => normalizedKey(r.author)),
  );
  const pubs = new Set(top.filter((r) => r.publication).map((r) => normalizedKey(r.publication)));
  return authors.size >= 2 || pubs.size >= 2;
}

/** Format the trace for `faithfulnessJudgeAgent` or `disagreementJudgeAgent`. */
export function formatJudgeInput(options: JudgeInputOptions): string {
  const { question, retrieved, answerText, promptLimit = 5 } = options;
  const blocks = retrieved.slice(0, promptLimit).map((p, i) => {
    const author = p.author || "Unknown";
    const pub = p.publication || p.url || "Unknown";
    const claimType = p.claim_type || "none";
    const claimText = p.claim_text || "";
    return (
      `[${i + 1}] Author: ${author} | Source: ${pub} | Epistemic Type: ${claimType}\n` +
      `Claim: ${claimText}\n` +
      `Passage Text: ${p.text ?? ""}`
    );
  });
  const contextStr = blocks.length > 0 ? blocks.join("\n\n") : "(0 passages retrieved)";
  return (
    `Question: ${question}\n\n` +
    `Retrieved Context:\n${contextStr}\n\n` +
    `Synthesized Answer:\n${answerText}`
  );
}

const STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "for",
  "that",
  "with",
  "this",
  "from",
  "are",
  "was",
  "were",
  "have",
  "has",
  "had",
  "not",
  "but",
  "what",
  "when",
  "where",
  "which",
  "who",
  "how",
  "why",
  "can",
  "will",
  "into",
  "over",
  "under",
  "more",
  "than",
  "only",
  "also",
  "their",
  "they",
  "them",
  "these",
  "those",
  "such",
  "some",
  "other",
  "while",
  "whereas",
  "across",
  "using",
  "uses",
  "used",
  "does",
]);

function contentTokens(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return new Set(tokens.filter((t) => t.length >= 4 && !STOPWORDS.has(t)));
}

/** FM-3 verdict when nothing was retrieved: abstaining passes, speculating fails. */
function judgeEmptyContext(answerText: string): BinaryVerdict {
  if (isAbstainAnswer(answerText)) {
    return {
      critique:
        "Retrieved context is empty and the synthesizer properly abstained " +
        "without fabricating unsupported claims.",
      verdict: "PASS",
      failure_code: "NONE",
    };
  }
  return {
    critique:
      "Retrieved context is empty, yet the answer speculated from pre-training " +
      "memory instead of abstaining.",
    verdict: "FAIL",
    failure_code: "FM-3",
  };
}

/** FM-4 verdict from the token overlap between the answer and its context. */
function judgeGrounding(question: string, top: Row[], answerText: string): BinaryVerdict {
  const contextBlob = top
    .map((p) => `${p.text ?? ""} ${p.claim_text ?? ""} ${p.author ?? ""}`)
    .join(" ");
  const ctxTokens = new Set([...contentTokens(contextBlob), ...contentTokens(question)]);
  const ansTokens = [...contentTokens(answerText)];

  if (ansTokens.length === 0) {
    return {
      critique: "Answer contains no substantive technical assertions to verify.",
      verdict: "FAIL",
      failure_code: "FM-4",
    };
  }

  const overlapRatio = ansTokens.filter((t) => ctxTokens.has(t)).length / ansTokens.length;
  if (overlapRatio < 0.42) {
    const unmatched = ansTokens
      .filter((t) => !ctxTokens.has(t))
      .sort()
      .slice(0, 6);
    return {
      critique:
        "Answer introduces unsupported claims or terminology not grounded in " +
        `the retrieved passages (unmatched tokens: ${unmatched.join(", ")}).`,
      verdict: "FAIL",
      failure_code: "FM-4",
    };
  }

  return {
    critique:
      `All cited assertions align with the retrieved passages (grounding overlap ` +
      `${Math.round(overlapRatio * 100)}%) and preserve the source's epistemic claim_type.`,
    verdict: "PASS",
    failure_code: "NONE",
  };
}

/** Deterministic fallback judge for FM-3 and FM-4 when `OPENAI_API_KEY` is not set. */
export function heuristicJudgeFaithfulness(options: JudgeInputOptions): BinaryVerdict {
  const { question, retrieved, answerText, promptLimit = 5 } = options;
  const top = retrieved.slice(0, promptLimit);
  if (top.length === 0) return judgeEmptyContext(answerText);

  if (isAbstainAnswer(answerText)) {
    return {
      critique: "Answer abstained cleanly when context coverage was limited.",
      verdict: "PASS",
      failure_code: "NONE",
    };
  }

  // Check epistemic inflation: if all cited passages are 'prediction' or 'opinion',
  // flag answers claiming "empirical benchmarks prove as an established measurement"
  const allNonMeasurements = top.every(
    (p) => p.claim_type === "prediction" || p.claim_type === "opinion",
  );
  const inflated = /\b(benchmarks?\s+prove|established\s+measurement|empirically\s+proven)\b/.test(
    answerText.toLowerCase(),
  );
  if (allNonMeasurements && inflated) {
    return {
      critique:
        "Epistemic inflation detected: the retrieved source is tagged as an " +
        `'${top[0]?.claim_type}', but the answer frames it as an ` +
        "empirically proven benchmark measurement.",
      verdict: "FAIL",
      failure_code: "FM-4",
    };
  }

  // Check token grounding overlap between answer and retrieved passages
  return judgeGrounding(question, top, answerText);
}

/** Normalized `field` values of the passages the answer cites by `[k]`. */
function citedValues(top: Row[], citedIndices: number[], field: string): Set<string> {
  const values = citedIndices
    .filter((idx) => idx >= 1 && idx <= top.length)
    .map((idx) => top[idx - 1]?.[field])
    .filter(Boolean);
  return new Set(values.map(normalizedKey));
}

/** Deterministic fallback judge for FM-5 (Cross-Publication Disagreement Coverage). */
export function heuristicJudgeDisagreement(
  options: Omit<JudgeInputOptions, "question">,
): BinaryVerdict {
  const { retrieved, answerText, promptLimit = 5 } = options;
  const top = retrieved.slice(0, promptLimit);
  if (!requiresDisagreementCheck(top, promptLimit)) {
    return {
      critique: "Single author or publication in context; no cross-publication conflict.",
      verdict: "PASS",
      failure_code: "NONE",
    };
  }

  const citedIndices = extractInlineCitationIndices(answerText);
  const citedAuthors = citedValues(top, citedIndices, "author");
  const citedPubs = citedValues(top, citedIndices, "publication");

  if (citedAuthors.size < 2 && citedPubs.size < 2 && citedIndices.length < 2) {
    return {
      critique:
        "Retrieved context contains perspectives from multiple authors/publications, " +
        "but the synthesized answer only cited one source and suppressed the " +
        "competing perspective.",
      verdict: "FAIL",
      failure_code: "FM-5",
    };
  }

  return {
    critique:
      "Synthesized answer explicitly surfaces and cites multiple authors/publications " +
      "from the retrieved context.",
    verdict: "PASS",
    failure_code: "NONE",
  };
}
