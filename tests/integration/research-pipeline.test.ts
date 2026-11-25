/**
 * Integration tests for bounded research runs and weekly digests against real Postgres:
 *
 * 1. `upsertResearchRun` and `getResearchRun` persist and retrieve hop traces,
 *    citations, evaluation summaries, and USD cost totals.
 * 2. `insertDigest` and `getLatestDigest` persist and retrieve weekly briefings.
 * 3. `kbResearchResult` and `kbWeeklyDigest` MCP tools read from Postgres.
 */

import { describe, expect, test } from "bun:test";
import {
  getLatestDigest,
  getResearchRun,
  insertDigest,
  upsertResearchRun,
} from "../../kb/db/queries";
import * as tools from "../../kb/mcp/tools";
import { POSTGRES_AVAILABLE, useRollbackDb } from "./db";

const CITATION = {
  citation_idx: 1,
  passage_id: "p-1",
  title: "Graph Fusion",
  author: "Miguel Otero Pedrido",
  url: "https://www.theneuralmaze.com/p/graph-fusion",
};
const DIGEST_TITLE = "The Substack Brain Weekly Digest (Test)";

describe.skipIf(!POSTGRES_AVAILABLE)("research and digest persistence against Postgres", () => {
  const db = useRollbackDb();

  async function saveSampleResearchRun(rid: string) {
    await upsertResearchRun(db(), {
      researchId: rid,
      eventId: "evt_test_01",
      question: "How does 3-way RRF compare to 2-way RRF across publications?",
      status: "completed",
      plan: ["3-way RRF vs 2-way RRF", "Memgraph claim traversal"],
      hops: [
        {
          hop: 1,
          queries: ["3-way RRF vs 2-way RRF"],
          newly_added_passages: 3,
          cumulative_passages: 3,
          decision: "sufficient",
          rationale: "Retrieved 3 grounded passages.",
          step_cost_usd: 0.0021,
        },
      ],
      reportText: "Three-way RRF lifts Recall@5 to 0.94 [1].",
      citations: [CITATION],
      retrieved: [
        { passage_id: "p-1", title: "Graph Fusion", text: "Three-way RRF lifts Recall@5 to 0.94." },
      ],
      evalSummary: {
        deterministic_passed: true,
        faithfulness_verdict: "PASS",
        disagreement_verdict: "NOT_APPLICABLE",
        failure_codes: [],
        composite_score: 1.0,
      },
      confidence: 1.0,
      iterationsUsed: 1,
      totalCostUsd: 0.0045,
      latencyMs: 420,
      completedAt: new Date(),
    });
  }

  test("research run and digest persistence, read back through the MCP tools", async () => {
    const rid = "res_research_test_01";
    await saveSampleResearchRun(rid);

    const now = new Date();
    await insertDigest(db(), {
      digestId: crypto.randomUUID(),
      windowStart: now,
      windowEnd: now,
      title: DIGEST_TITLE,
      summaryMarkdown: "# Weekly Digest\n\n- **Miguel**: 3-way RRF reaches 0.94 Recall@5 [1].",
      citations: [CITATION],
      stats: { articles_count: 3, claims_count: 9, deterministic_passed: true },
    });

    const storedRun = await getResearchRun(db(), rid);
    expect(storedRun).not.toBeNull();
    expect(storedRun?.status).toBe("completed");
    expect(storedRun?.confidence).toBe(1.0);

    const mcpRun = await tools.kbResearchResult(rid);
    expect(mcpRun.research_id).toBe(rid);
    expect(mcpRun.iterations_used).toBe(1);

    const storedDigest = await getLatestDigest(db());
    expect(storedDigest?.title).toBe(DIGEST_TITLE);

    const mcpDigest = await tools.kbWeeklyDigest();
    expect(mcpDigest.title).toBe(DIGEST_TITLE);
  });

  test("kbResearchResult throws for an unknown research id", async () => {
    await expect(tools.kbResearchResult("res_does_not_exist")).rejects.toThrow(
      "No research run found for research_id='res_does_not_exist'.",
    );
  });
});
