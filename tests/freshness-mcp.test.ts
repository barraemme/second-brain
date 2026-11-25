/**
 * Freshness tests: conditional polling, supersession, failure tracking, and MCP tools.
 *
 * Like basics.test.ts and flow-control.test.ts, these unit tests verify pure logic and contracts
 * without requiring external network or live Docker services.
 */

import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { pollFeeds } from "../kb/functions/freshness";
import { failureFromEvent, handleFunctionFailed } from "../kb/functions/ops";
import { createMcpServer } from "../kb/mcp/server";
import { ArticleUpdated } from "../kb/schemas/events";

const EXPECTED_TOOLS = [
  "kb_health",
  "kb_add_publication",
  "kb_search",
  "kb_ask",
  "kb_backfill",
  "kb_job_status",
  "kb_list_publications",
  "kb_sync",
  "kb_sources",
  "kb_eval_report",
  "kb_research",
  "kb_research_result",
  "kb_weekly_digest",
];

async function listMcpTools() {
  const mcp = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  const mcpClient = new Client({ name: "unit-test", version: "0.0.0" });
  try {
    await mcpClient.connect(clientTransport);
    return (await mcpClient.listTools()).tools;
  } finally {
    await mcpClient.close();
    await mcp.close();
  }
}

describe("MCP server", () => {
  test("registers all thirteen tools, with kb_search limit bounded 1..25", async () => {
    const tools = await listMcpTools();
    expect(new Set(tools.map((t) => t.name))).toEqual(new Set(EXPECTED_TOOLS));

    const searchTool = tools.find((t) => t.name === "kb_search");
    const limit = searchTool?.inputSchema.properties?.limit as Record<string, unknown> | undefined;
    expect(limit?.minimum).toBe(1);
    expect(limit?.maximum).toBe(25);
  });
});

describe("Inngest function triggers", () => {
  test("poll-feeds runs on a 5-minute cron and on kb/feed.poll", () => {
    expect(pollFeeds.opts.triggers).toEqual([{ cron: "*/5 * * * *" }, { event: "kb/feed.poll" }]);
  });

  test("handle-function-failed listens to inngest/function.failed", () => {
    expect(handleFunctionFailed.opts.triggers).toEqual([{ event: "inngest/function.failed" }]);
  });
});

describe("failureFromEvent", () => {
  test("serializes an object error and keeps the original event", () => {
    const failure = failureFromEvent({
      name: "inngest/function.failed",
      id: "evt_1",
      data: {
        function_id: "substack-brain-ingest-article",
        run_id: "run_1",
        error: { message: "boom" },
        event: { name: "kb/article.discovered" },
      },
    });
    expect(failure).toEqual({
      functionId: "substack-brain-ingest-article",
      runId: "run_1",
      error: '{"message":"boom"}',
      eventData: { name: "kb/article.discovered" },
    });
  });

  test("falls back to the event name, event id and a raw payload", () => {
    const failure = failureFromEvent({ name: "inngest/function.failed", id: "evt_2", data: {} });
    expect(failure).toEqual({
      functionId: "inngest/function.failed",
      runId: "evt_2",
      error: "Unknown error",
      eventData: { raw: {} },
    });
  });
});

test("ArticleUpdated event schema keeps snake_case keys", () => {
  const aid = crypto.randomUUID();
  const event = ArticleUpdated.parse({
    canonical_id: "pub:test:post-1",
    article_id: aid,
    content_hash: "abc123hash",
    passage_count: 4,
  });
  expect(event.canonical_id).toBe("pub:test:post-1");
  expect(event.article_id).toBe(aid);
  expect(event.passage_count).toBe(4);
});
