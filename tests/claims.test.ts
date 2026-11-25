/**
 * Claim extraction unit tests: `extract-claims` function config, Cypher invariants, agent
 * layer, and `ClaimsExtracted` event contract.
 *
 * Runs with zero Docker, database, or external API dependencies.
 */

import { describe, expect, test } from "bun:test";
import { type Agent, runAgent } from "../kb/agents/core";
import { FUNCTIONS } from "../kb/functions";
import { extractClaims } from "../kb/functions/enrich";
import * as cypher from "../kb/graph/cypher";
import { client } from "../kb/inngest-client";
import { ClaimExtractionBatch } from "../kb/schemas/entities";
import { ARTICLE_INGESTED, ARTICLE_UPDATED, ClaimsExtracted } from "../kb/schemas/events";

describe("extract-claims config", () => {
  test("is registered in the FUNCTIONS list", () => {
    const fnIds = new Set(FUNCTIONS.map((fn) => fn.id(client.id)));
    expect(fnIds.has("substack-brain-extract-claims")).toBe(true);
  });

  test("triggers on ingested and updated events", () => {
    const events = new Set(
      (extractClaims.opts.triggers ?? []).map((t) => ("event" in t ? t.event : undefined)),
    );
    expect(events).toEqual(new Set([ARTICLE_INGESTED, ARTICLE_UPDATED]));
  });

  test("concurrency serializes per canonical_id", () => {
    const concurrency = extractClaims.opts.concurrency;
    expect(Array.isArray(concurrency)).toBe(true);
    const perArticle = (Array.isArray(concurrency) ? concurrency : []).find(
      (c) => c.key === "event.data.canonical_id",
    );
    expect(perArticle?.limit).toBe(1);
  });
});

test("cypher module obeys parameterization, MERGE and valid_to invariants", () => {
  const statements: [string, string][] = [];
  for (const [name, value] of Object.entries(cypher)) {
    if (name.endsWith("_CYPHER") && typeof value === "string") statements.push([name, value]);
  }
  expect(statements.length).toBeGreaterThanOrEqual(7);

  for (const [name, stmt] of statements) {
    // Rule 1: Every query taking inputs must use $parameter placeholders
    if (name !== "COUNT_ACTIVE_CLAIMS_AND_TOPICS_CYPHER") expect(stmt).toContain("$");
    // Rule 2: Never standalone CREATE (only ON CREATE SET inside MERGE)
    const withoutOnCreate = stmt.replace(/ON\s+CREATE\s+SET/gi, "");
    expect(withoutOnCreate).not.toMatch(/\bCREATE\b/i);
  }

  // Rule 3: Every read/traversal query must filter valid_to IS NULL
  for (const readStmt of [
    cypher.SEARCH_CLAIMS_BY_TOPICS_CYPHER,
    cypher.GET_CLAIM_PROVENANCE_CYPHER,
    cypher.COUNT_ACTIVE_CLAIMS_AND_TOPICS_CYPHER,
    cypher.CROSS_PUBLICATION_DISAGREEMENTS_CYPHER,
  ]) {
    expect(readStmt).toContain("valid_to IS NULL");
  }
});

test("ClaimsExtracted event schema keeps snake_case keys", () => {
  const aid = crypto.randomUUID();
  const evt = ClaimsExtracted.parse({
    article_id: aid,
    canonical_id: "pub:the-neural-maze:graph-rag",
    claim_count: 4,
    dropped_spans: 1,
  });
  expect(evt).toEqual({
    article_id: aid,
    canonical_id: "pub:the-neural-maze:graph-rag",
    claim_count: 4,
    dropped_spans: 1,
  });
});

test("runAgent wraps the call in an Inngest step and validates the schema", async () => {
  const recordedStepIds: string[] = [];
  const dummyStep = {
    run: async (stepId: string, _fn: () => unknown) => {
      recordedStepIds.push(stepId);
      return {
        output: {
          claims: [
            {
              claim_text: "Reciprocal Rank Fusion needs no score calibration.",
              quote_span: "Reciprocal Rank Fusion combines rankings using only ordinal positions.",
              claim_type: "opinion",
              entities: ["Reciprocal Rank Fusion"],
              confidence: 0.94,
            },
          ],
        },
        usage: {
          model: "claude-sonnet-5-5",
          input_tokens: 120,
          output_tokens: 45,
          est_usd: 0.001035,
        },
      };
    },
  };

  const testAgent: Agent<ClaimExtractionBatch> = {
    name: "test-extractor",
    role: "Test Extractor",
    system_prompt: "Extract claims.",
    model: "claude-sonnet-5-5",
    output_schema: ClaimExtractionBatch,
    max_tokens: 2048,
  };

  const result = await runAgent(dummyStep, testAgent, "Article text", "extract-claims-llm");

  expect(recordedStepIds).toEqual(["extract-claims-llm"]);
  expect(result.claims).toHaveLength(1);
  expect(result.claims[0]?.claim_type).toBe("opinion");
  expect(result.claims[0]?.confidence).toBe(0.94);
});
