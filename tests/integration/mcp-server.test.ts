/**
 * Protocol-level check: the MCP server actually serves its tools correctly.
 *
 * Connects an in-process SDK `Client` to the real `McpServer` over an in-memory
 * transport (no subprocess). This exercises the real MCP protocol (tool listing,
 * JSON schema, `callTool` request/response), which calling the tool functions
 * directly (see mcp-tools.test.ts) does not.
 *
 * Listing tools needs no infrastructure. Calling `kb_health` needs the dev stack
 * (Postgres and the Inngest Dev Server); it is skipped when either is down.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { settings } from "../../kb/config";
import { createMcpServer } from "../../kb/mcp/server";
import { POSTGRES_AVAILABLE } from "./db";

const PROBE_TIMEOUT_MS = 2_000;

async function probeInngest(): Promise<boolean> {
  try {
    await fetch(settings.inngestBaseUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return true;
  } catch (error) {
    console.warn(`Inngest Dev Server not reachable at ${settings.inngestBaseUrl}: ${error}`);
    return false;
  }
}

const STACK_AVAILABLE = POSTGRES_AVAILABLE && (await probeInngest());

describe("MCP server over the real protocol", () => {
  let server: McpServer;
  let mcpClient: Client;

  beforeEach(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = createMcpServer();
    mcpClient = new Client({ name: "mcp-server-test", version: "0.0.0" });
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
  });

  afterEach(async () => {
    await mcpClient.close();
    await server.close();
  });

  test("lists all thirteen tools", async () => {
    const result = await mcpClient.listTools();
    expect(new Set(result.tools.map((t) => t.name))).toEqual(
      new Set([
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
      ]),
    );
  });

  test("kb_search schema enforces the limit bounds", async () => {
    const result = await mcpClient.listTools();
    const kbSearch = result.tools.find((t) => t.name === "kb_search");
    const limitSchema = kbSearch?.inputSchema.properties?.limit as Record<string, unknown>;
    expect(limitSchema.minimum).toBe(1);
    expect(limitSchema.maximum).toBe(25);
  });

  test("kb_search rejects an out-of-range limit before running", async () => {
    const result = await mcpClient.callTool({
      name: "kb_search",
      arguments: { query: "x", limit: 99 },
    });
    expect(result.isError).toBe(true);
  });

  test.skipIf(!STACK_AVAILABLE)("calls kb_health over the real protocol", async () => {
    const result = await mcpClient.callTool({ name: "kb_health", arguments: {} });
    expect(result.isError).not.toBe(true);
    const content = result.content as { type: string; text: string }[];
    const first = content[0];
    expect(first?.type).toBe("text");
    expect(JSON.parse(first?.text ?? "{}").status).toBe("ok");
  });
});
