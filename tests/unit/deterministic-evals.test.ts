/**
 * Unit tests for Level 1 deterministic code evaluators (`kb/evals/deterministic.ts`).
 *
 * Runs in milliseconds with zero network, database, or LLM dependencies.
 */

import { expect, test } from "bun:test";
import { extractInlineCitationIndices, runDeterministicChecks } from "../../kb/evals/deterministic";

test("extractInlineCitationIndices preserves order and deduplicates", () => {
  const text = "Inngest memoizes steps [1] while RRF combines rankings [2] and [1].";
  expect(extractInlineCitationIndices(text)).toEqual([1, 2]);
});

test("deterministic checks pass on a valid grounded snapshot", () => {
  const retrieved = [
    { passage_id: "p-1", text: "Passage one text.", valid_to: null },
    { passage_id: "p-2", text: "Passage two text.", valid_to: null },
  ];
  const citations = [{ citation_idx: 1, passage_id: "p-1", valid_to: null }];
  const res = runDeterministicChecks({
    answerText: "Grounded claim citing passage one [1].",
    citations,
    retrieved,
  });
  expect(res.passed).toBe(true);
  expect(res.failure_codes).toEqual([]);
  expect(res.score).toBe(1.0);
});

test("deterministic checks catch an out-of-bounds phantom citation (FM-1)", () => {
  const retrieved = [{ passage_id: "p-1", text: "Passage one text.", valid_to: null }];
  const citations = [{ citation_idx: 1, passage_id: "p-1", valid_to: null }];
  const res = runDeterministicChecks({
    answerText: "Grounded [1] plus phantom [4].",
    citations,
    retrieved,
  });
  expect(res.passed).toBe(false);
  expect(res.checks.citation_bounds_valid).toBe(false);
  expect(res.failure_codes).toContain("FM-1");
});

test("deterministic checks catch an unretrieved citation passage_id (FM-1)", () => {
  const retrieved = [{ passage_id: "p-1", text: "Passage one text.", valid_to: null }];
  const citations = [{ citation_idx: 1, passage_id: "p-nonexistent", valid_to: null }];
  const res = runDeterministicChecks({
    answerText: "Answer with dangling passage_id [1].",
    citations,
    retrieved,
  });
  expect(res.passed).toBe(false);
  expect(res.checks.citations_subset_of_retrieved).toBe(false);
  expect(res.failure_codes).toContain("FM-1");
});

test("deterministic checks catch a superseded source (FM-2)", () => {
  const retrieved = [
    { passage_id: "p-old", text: "Superseded text.", valid_to: "2026-10-01T00:00:00Z" },
  ];
  const citations = [{ citation_idx: 1, passage_id: "p-old" }];
  const res = runDeterministicChecks({
    answerText: "Answer citing a stale revision [1].",
    citations,
    retrieved,
  });
  expect(res.passed).toBe(false);
  expect(res.checks.no_superseded_sources_cited).toBe(false);
  expect(res.failure_codes).toContain("FM-2");
});

test("deterministic checks catch speculation on empty retrieval (FM-3)", () => {
  const res = runDeterministicChecks({
    answerText: "When configuring Cilium BGP, enable bgpControlPlane in Helm.",
    citations: [],
    retrieved: [],
  });
  expect(res.passed).toBe(false);
  expect(res.checks.abstain_or_cite_discipline).toBe(false);
  expect(res.failure_codes).toContain("FM-3");
});

test("deterministic checks pass on a clean abstain when retrieval is empty", () => {
  const res = runDeterministicChecks({
    answerText: "No relevant passages were found in the knowledge base for this question.",
    citations: [],
    retrieved: [],
  });
  expect(res.passed).toBe(true);
  expect(res.failure_codes).toEqual([]);
});
