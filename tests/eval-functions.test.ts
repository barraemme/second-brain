/**
 * Evaluation unit tests: Inngest evaluation functions (`evaluate-answer`,
 * `run-eval-suite`), failure taxonomy fixture, MCP tool registration (`kb_eval_report`),
 * and event schemas (`EvalRunRequested`, `AnswerEvaluated`).
 *
 * Runs with zero Docker containers or external API keys.
 */

import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parse as parseYaml } from "yaml";
import { settings } from "../kb/config";
import { FUNCTIONS } from "../kb/functions";
import { compositeScore, evaluateAnswer, runEvalSuite } from "../kb/functions/evals";
import { client } from "../kb/inngest-client";
import { createMcpServer } from "../kb/mcp/server";
import {
  ANSWER_EVALUATED,
  ANSWER_PRODUCED,
  AnswerEvaluated,
  EVAL_RUN_REQUESTED,
  EvalRunRequested,
} from "../kb/schemas/events";

function triggerEvents(fn: (typeof FUNCTIONS)[number]): Set<string | undefined> {
  return new Set((fn.opts.triggers ?? []).map((t) => ("event" in t ? t.event : undefined)));
}

async function listToolNames(): Promise<string[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const mcpClient = new Client({ name: "unit-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  try {
    return (await mcpClient.listTools()).tools.map((t) => t.name);
  } finally {
    await mcpClient.close();
    await server.close();
  }
}

describe("eval functions", () => {
  test("are registered in the FUNCTIONS list", () => {
    const fnIds = new Set(FUNCTIONS.map((fn) => fn.id(client.id)));
    expect(fnIds.has("substack-brain-evaluate-answer")).toBe(true);
    expect(fnIds.has("substack-brain-run-eval-suite")).toBe(true);
  });

  test("evaluate-answer triggers on answer produced", () => {
    expect(triggerEvents(evaluateAnswer)).toEqual(new Set([ANSWER_PRODUCED]));
  });

  test("run-eval-suite triggers on eval run requested", () => {
    expect(triggerEvents(runEvalSuite)).toEqual(new Set([EVAL_RUN_REQUESTED]));
  });

  test("composite score: 0 on deterministic/faithfulness failure, 0.5 on disagreement failure", () => {
    expect(compositeScore(true, "PASS", "NOT_APPLICABLE")).toBe(1.0);
    expect(compositeScore(true, "PASS", "FAIL")).toBe(0.5);
    expect(compositeScore(false, "PASS", "PASS")).toBe(0.0);
    expect(compositeScore(true, "FAIL", "FAIL")).toBe(0.0);
  });
});

test("taxonomy yaml defines all six axial failure modes", async () => {
  const data = parseYaml(await Bun.file(settings.evalTaxonomyFile).text()) as {
    failure_modes: { code: string }[];
  };
  const codes = data.failure_modes.map((m) => m.code);
  expect(codes).toEqual(["FM-1", "FM-2", "FM-3", "FM-4", "FM-5", "FM-6"]);
});

test("MCP server registers kb_eval_report as the tenth tool", async () => {
  const names = await listToolNames();
  expect(names).toContain("kb_eval_report");
  expect(names.length).toBeGreaterThanOrEqual(10);
});

test("eval event schemas", () => {
  const req = EvalRunRequested.parse({ suite_name: "golden_v1", include_failures_table: true });
  expect(req).toEqual({ suite_name: "golden_v1", include_failures_table: true });

  const evaluated = AnswerEvaluated.parse({
    snapshot_id: "snap-123",
    composite_score: 1.0,
    deterministic_passed: true,
    faithfulness_verdict: "PASS",
    disagreement_verdict: "NOT_APPLICABLE",
    failure_codes: [],
  });
  expect(evaluated.snapshot_id).toBe("snap-123");
  expect(evaluated.composite_score).toBe(1.0);
  expect(ANSWER_EVALUATED).toBe("kb/answer.evaluated");
});
