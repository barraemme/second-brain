/**
 * Unit tests for the bounded research agent primitives (`boundedLoop`,
 * `mergeHopCandidates`, planner/critic/synthesizer roles, and deterministic checks).
 *
 * Requires zero Docker containers, database connections, or external API keys.
 */

import { expect, test } from "bun:test";
import { z } from "zod";
import { type Agent, boundedLoop, runAgent, type StepRunner } from "../../kb/agents/core";
import {
  CoverageReflection,
  extractCitedEntries,
  heuristicPlanQueries,
  heuristicReflectCoverage,
  heuristicSynthesizeDigest,
  heuristicSynthesizeResearch,
  mergeHopCandidates,
  ResearchPlan,
} from "../../kb/agents/roles/researcher";
import { runDeterministicChecks } from "../../kb/evals/deterministic";

const StepReply = z.object({ step_num: z.number().int(), done: z.boolean() });
type StepReply = z.infer<typeof StepReply>;

/** A fake Inngest `step`: records step ids and returns a canned `{ output, usage }`. */
function fakeStep(executedSteps: string[], estUsd: number, doneAt: number | null): StepRunner {
  return {
    run: async (stepId) => {
      executedSteps.push(stepId);
      const idx = executedSteps.length;
      return {
        output: { step_num: idx, done: idx === doneAt },
        usage: {
          model: "claude-haiku-5-5",
          input_tokens: 100,
          output_tokens: 50,
          est_usd: estUsd,
        },
      };
    },
  };
}

function loopAgent(name: string): Agent<StepReply> {
  return {
    name,
    role: "Test Loop Agent",
    system_prompt: "Test",
    model: "claude-haiku-5-5",
    output_schema: StepReply,
  };
}

test("boundedLoop halts when shouldStop returns true", async () => {
  const executedSteps: string[] = [];
  const outputs = await boundedLoop(
    fakeStep(executedSteps, 0.01, 2),
    loopAgent("loop-test"),
    "start",
    {
      stepPrefix: "research-hop",
      shouldStop: (out) => out.done,
      nextInput: (_out, i) => `input-${i + 1}`,
      maxIterations: 5,
      maxUsd: 0.5,
    },
  );

  expect(outputs).toHaveLength(2);
  expect(executedSteps).toEqual(["research-hop-1", "research-hop-2"]);
});

test("boundedLoop halts immediately when maxUsd is exceeded", async () => {
  const executedSteps: string[] = [];
  const outputs = await boundedLoop(
    fakeStep(executedSteps, 0.15, null),
    loopAgent("cost-test"),
    "start",
    {
      stepPrefix: "expensive-hop",
      shouldStop: () => false,
      nextInput: (_out, i) => `input-${i + 1}`,
      maxIterations: 5,
      maxUsd: 0.25,
    },
  );

  // 2 steps * $0.15 = $0.30 >= $0.25 -> halts after step 2 without running step 3
  expect(outputs).toHaveLength(2);
  expect(executedSteps).toEqual(["expensive-hop-1", "expensive-hop-2"]);
});

test("runAgent rejects a step output that does not match the agent schema", async () => {
  const step: StepRunner = { run: async () => ({ output: { step_num: "x" }, usage: {} }) };
  await expect(runAgent(step, loopAgent("bad-output"), "start", "bad-step")).rejects.toThrow();
});

test("mergeHopCandidates deduplicates and keeps the highest rrf_score", () => {
  const hop1 = [
    {
      passage_id: "p-1",
      text: "Inngest step.run memoizes step outputs.",
      title: "Durable Execution",
      author: "Miguel",
      url: "https://theneuralmaze.com/p/durable",
      published_at: "2026-10-01T00:00:00+00:00",
      rrf_score: 0.032,
    },
    {
      passage_id: "p-2",
      text: "Reciprocal Rank Fusion combines rankings.",
      title: "Hybrid Search",
      author: "Paul",
      url: "https://www.decodingai.com/p/rrf",
      published_at: "2026-10-02T00:00:00+00:00",
      rrf_score: 0.016,
    },
  ];
  const hop2 = [
    {
      passage_id: "p-2",
      text: "Reciprocal Rank Fusion combines rankings.",
      title: "Hybrid Search",
      author: "Paul",
      url: "https://www.decodingai.com/p/rrf",
      published_at: "2026-10-02T00:00:00+00:00",
      rrf_score: 0.048,
      claim_id: "c-222",
      claim_text: "RRF requires no score calibration.",
      claim_type: "opinion",
    },
    {
      passage_id: "p-3",
      text: "Small language models reduce latency by 40%.",
      title: "SLMs in Production",
      author: "Sebastian",
      url: "https://magazine.sebastianraschka.com/p/slm",
      published_at: "2026-10-03T00:00:00+00:00",
      rrf_score: 0.025,
    },
  ];

  const [merged, newlyAdded] = mergeHopCandidates(hop1, hop2);
  expect(newlyAdded).toBe(1);
  expect(merged.map((m) => m.passage_id)).toEqual(["p-2", "p-1", "p-3"]);
  expect(merged[0]?.rrf_score).toBe(0.048);
  expect(merged[0]?.claim_id).toBe("c-222");
  expect(merged[0]?.claim_type).toBe("opinion");
});

test("heuristic planner and critic produce valid schemas", () => {
  const plan = heuristicPlanQueries(
    "How does Reciprocal Rank Fusion compare to pgvector dense search and Memgraph?",
    { maxSubqueries: 3 },
  );
  expect(ResearchPlan.safeParse(plan).success).toBe(true);
  expect(plan.subqueries.length).toBeGreaterThanOrEqual(1);
  expect(plan.subqueries.length).toBeLessThanOrEqual(3);
  expect(plan.target_topics).toContain("Reciprocal Rank Fusion");

  // Reflection when topic is still missing on hop 1
  const evidence = [
    {
      passage_id: "p-1",
      title: "Vector Search",
      text: "pgvector indexes cosine similarity.",
      author: "Miguel",
      url: "https://theneuralmaze.com/p/vec",
      rrf_score: 0.03,
    },
  ];
  const refHop1 = heuristicReflectCoverage(
    "How does Reciprocal Rank Fusion compare to pgvector?",
    plan.subqueries,
    evidence,
    ["Reciprocal Rank Fusion", "pgvector"],
    1,
  );
  expect(CoverageReflection.safeParse(refHop1).success).toBe(true);
  expect(refHop1.is_sufficient).toBe(false);
  expect(refHop1.missing_aspects).toContain("Reciprocal Rank Fusion");
  expect(refHop1.followup_queries.length).toBeGreaterThanOrEqual(1);
});

test("heuristic research brief and digest pass Level 1 deterministic checks", () => {
  const passages = [
    {
      passage_id: "p-101",
      claim_id: "c-101",
      claim_text: "Three-way RRF lifts Recall@5 to 0.94 across publications.",
      claim_type: "measurement",
      text: "Three-way RRF lifts Recall@5 to 0.94 across publications.",
      title: "Graph Fusion",
      author: "Miguel Otero Pedrido",
      url: "https://theneuralmaze.com/p/graph-fusion",
      published_at: "2026-10-20T00:00:00+00:00",
      valid_to: null,
    },
    {
      passage_id: "p-102",
      claim_id: "c-102",
      claim_text: "Hybrid search with reranking should be carefully benchmarked.",
      claim_type: "opinion",
      text: "Hybrid search with reranking should be carefully benchmarked.",
      title: "Pragmatic RAG",
      author: "Paul Iusztin",
      url: "https://www.decodingai.com/p/pragmatic-rag",
      published_at: "2026-10-21T00:00:00+00:00",
      valid_to: null,
    },
  ];

  const report = heuristicSynthesizeResearch(
    "How do authors evaluate hybrid RAG retrieval?",
    passages,
  );
  const detRes = runDeterministicChecks({
    answerText: report,
    citations: extractCitedEntries(report, passages),
    retrieved: passages,
    promptLimit: 5,
  });
  expect(detRes.passed).toBe(true);
  expect(detRes.failure_codes).toEqual([]);

  const digestMd = heuristicSynthesizeDigest("Weekly Digest (2026-10-22 to 2026-10-29)", passages, [
    { slug: "rag", name: "RAG", is_cross_publication: true, claim_count: 2 },
  ]);
  const detDigest = runDeterministicChecks({
    answerText: digestMd,
    citations: extractCitedEntries(digestMd, passages),
    retrieved: passages,
    promptLimit: 10,
  });
  expect(detDigest.passed).toBe(true);
  expect(detDigest.failure_codes).toEqual([]);
});
