#!/usr/bin/env bun
/**
 * `kb-mcp` entrypoint. stdio transport.
 *
 * `createMcpServer()` builds the server with all 13 tools and no transport, so
 * tests can connect it to an in-memory client. Running this file directly
 * (`bun kb/mcp/server.ts`, `bun run mcp`, the `kb-mcp` bin) serves it on stdio.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as tools from "./tools";

export const SERVER_NAME = "second-brain";
const SERVER_VERSION = "0.1.0";

export const INSTRUCTIONS =
  "Query and grow a knowledge base built from technical newsletters. " +
  "Prefer kb_search and kb_ask over generic web search for anything about a " +
  "covered publication. Tools that trigger work (kb_add_publication, kb_backfill, " +
  "kb_sync) return a handle immediately; poll kb_job_status for progress.";

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const IDEMPOTENT_WRITE: ToolAnnotations = { ...READ_ONLY, readOnlyHint: false };
const NON_IDEMPOTENT_WRITE: ToolAnnotations = { ...IDEMPOTENT_WRITE, idempotentHint: false };

/** A tool's dict result as MCP content: JSON text plus the same object as structured content. */
function jsonResult(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

function registerReadTools(server: McpServer): void {
  server.registerTool(
    "kb_health",
    {
      description:
        "Check whether Postgres, the Inngest Dev Server, and Memgraph are reachable.\n\n" +
        "Returns article, passage, active claim, and topic counts alongside per-subsystem\n" +
        'status (`"ok"` or `"error: <detail>"`). Call this first if any other tool call\n' +
        "fails unexpectedly - it tells you which dependency is actually down.",
      annotations: READ_ONLY,
    },
    async () => jsonResult(await tools.kbHealth()),
  );
  server.registerTool(
    "kb_search",
    {
      description:
        "Three-way hybrid (BM25 + pgvector + Memgraph claim graph, RRF-fused) search.\n\n" +
        "Combines full-text BM25 search, pgvector semantic similarity, and Memgraph\n" +
        "topic-to-claim traversal using Reciprocal Rank Fusion. Returns real, attributed\n" +
        "passages with title, author, URL, date, text snippet, and any matched claim metadata.\n" +
        'Returns `{"results": []}` when nothing matches.',
      inputSchema: {
        query: z.string().describe("Free-text search query, e.g. 'agentic RAG evals'"),
        limit: z.number().int().min(1).max(25).default(5).describe("Max passages to return (1-25)"),
      },
      annotations: READ_ONLY,
    },
    async ({ query, limit }) => jsonResult(await tools.kbSearch(query, limit)),
  );
  server.registerTool(
    "kb_ask",
    {
      description:
        "Answer a technical question using 3-way hybrid retrieval and inline citations.\n\n" +
        "Fast read path: performs 3-way Reciprocal Rank Fusion (BM25 lexical search +\n" +
        "pgvector dense similarity + Memgraph claim graph traversal) and synthesizes an\n" +
        "answer with inline citations (`[1]`, `[2]`) and an `as_of` freshness timestamp.\n" +
        "Automatically surfaces cross-publication disagreements when authors conflict on a\n" +
        "shared topic. Never creates an Inngest run. Records a retrieval snapshot for evaluation.",
      inputSchema: {
        question: z.string().describe("Technical question to answer from the knowledge base"),
      },
      annotations: READ_ONLY,
    },
    async ({ question }) => jsonResult(await tools.kbAsk(question)),
  );
}

function registerStatusTools(server: McpServer): void {
  server.registerTool(
    "kb_job_status",
    {
      description:
        "Check progress of a publication ingestion or backfill job.\n\n" +
        "Combines this repo's own `jobs` row (article counts) with the Inngest Dev\n" +
        "Server's real run status and step execution details for that event.",
      inputSchema: {
        event_id: z.string().describe("The event_id returned by kb_add_publication or kb_backfill"),
      },
      annotations: READ_ONLY,
    },
    async ({ event_id }) => jsonResult(await tools.kbJobStatus(event_id)),
  );
  server.registerTool(
    "kb_list_publications",
    {
      description:
        "List all publications in the knowledge base alongside article counts and sync metadata.",
      annotations: READ_ONLY,
    },
    async () => jsonResult(await tools.kbListPublications()),
  );
}

function registerProvenanceTools(server: McpServer): void {
  server.registerTool(
    "kb_sources",
    {
      description:
        "Inspect full provenance, verbatim quote, and temporal validity for a cited claim or passage.\n\n" +
        "When to use `kb_sources` vs `kb_search`:\n" +
        "- Use `kb_search` to discover relevant passages by free-text query.\n" +
        "- Use `kb_sources` when you already have a specific `claim_id` or `passage_id`\n" +
        "  from a citation and want to verify its exact verbatim quote (`quote_span` or\n" +
        "  passage text), author, publication, epistemic `claim_type` (`opinion`,\n" +
        "  `measurement`, `prediction`), canonical topics, and temporal validity\n" +
        "  (`valid_from`, `valid_to`, `is_active`, `supersedes_id`).",
      inputSchema: {
        claim_or_passage_id: z
          .string()
          .describe(
            "UUID of a cited claim (`claim_id`) or passage (`passage_id`) " +
              "returned by kb_ask or kb_search",
          ),
      },
      annotations: READ_ONLY,
    },
    async ({ claim_or_passage_id }) => jsonResult(await tools.kbSources(claim_or_passage_id)),
  );
  server.registerTool(
    "kb_eval_report",
    {
      description:
        "Return the evaluation report: failure taxonomy counts (`FM-1`..`FM-6`),\n" +
        "deterministic and binary LLM judge pass rates, recent snapshot critiques, and\n" +
        "the latest multi-variant retrieval benchmark (`sparse`, `dense`, `2-way RRF`,\n" +
        "`3-way RRF`).",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Max recent evaluated snapshots to include (1-50)"),
      },
      annotations: READ_ONLY,
    },
    async ({ limit }) => jsonResult(await tools.kbEvalReport(limit)),
  );
}

function registerIngestionTools(server: McpServer): void {
  server.registerTool(
    "kb_add_publication",
    {
      description:
        "Add a publication by its RSS feed URL and start ingesting its articles.\n\n" +
        "The feed's host must already be listed in this repo's `publications.yaml`\n" +
        "allowlist - this tool refuses (via a fast, deterministic Inngest rejection)\n" +
        "anything outside it rather than silently ingesting an unapproved source.\n\n" +
        "Returns immediately with `{event_id, trace_url, status}`; it does not wait\n" +
        "for ingestion to finish. Poll `kb_job_status(event_id)` with the returned\n" +
        "`event_id` to see progress, and use `trace_url` to inspect the run in the\n" +
        "Inngest Dev Server UI.",
      inputSchema: {
        feed_url: z
          .string()
          .describe("The publication's RSS feed URL, e.g. https://example.substack.com/feed"),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ feed_url }) => jsonResult(await tools.kbAddPublication(feed_url)),
  );
  server.registerTool(
    "kb_backfill",
    {
      description:
        "Trigger a backfill ingestion run for one publication or all allowlisted publications.\n\n" +
        "Discovers all available posts from the RSS feed, skipping already ingested\n" +
        "articles, and queues ingestion jobs. Returns immediately with the primary\n" +
        "event_id and trace_url.",
      inputSchema: {
        publication: z
          .string()
          .default("all")
          .describe("Publication slug, feed URL, or 'all' to backfill all publications"),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ publication }) => jsonResult(await tools.kbBackfill(publication)),
  );
  server.registerTool(
    "kb_sync",
    {
      description:
        "Force an immediate freshness poll instead of waiting for the 5-minute cron.\n\n" +
        "Dispatches `kb/feed.poll` to Inngest to check HTTP conditional headers\n" +
        "(ETag / Last-Modified) against origins and discover new articles immediately.",
      inputSchema: {
        publication: z
          .string()
          .nullish()
          .describe("Optional publication slug to sync, or None to poll all feeds"),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ publication }) => jsonResult(await tools.kbSync(publication)),
  );
}

function registerResearchTools(server: McpServer): void {
  server.registerTool(
    "kb_research",
    {
      description:
        "Queue a bounded multi-hop research agent run (`run-research-agent`).\n\n" +
        "Slow write (<50ms): decomposes the question into sub-queries, runs iterative\n" +
        "3-way hybrid retrieval and coverage reflection up to `max_iterations` or `max_usd`,\n" +
        "synthesizes a cited report, and verifies it with deterministic and binary\n" +
        'judges. Returns `{research_id, event_id, trace_url, status: "queued"}` immediately;\n' +
        "poll `kb_research_result(research_id)` to fetch the completed report.",
      inputSchema: {
        question: z
          .string()
          .describe(
            "Complex multi-hop or cross-publication engineering research question " +
              "to investigate asynchronously",
          ),
        max_iterations: z
          .number()
          .int()
          .min(1)
          .max(5)
          .default(3)
          .describe("Max retrieval + reflection hops before synthesis (1-5)"),
        max_usd: z
          .number()
          .positive()
          .max(2.0)
          .default(0.25)
          .describe("Hard USD token cost budget for the research run"),
      },
      annotations: NON_IDEMPOTENT_WRITE,
    },
    async ({ question, max_iterations, max_usd }) =>
      jsonResult(await tools.kbResearch(question, max_iterations, max_usd)),
  );
  server.registerTool(
    "kb_research_result",
    {
      description:
        "Fetch the status, hop trace, cited report, and evaluation summary for a bounded research run.\n\n" +
        "Fast read (<1s): queries `research_runs` directly in Postgres without creating an\n" +
        "Inngest run.",
      inputSchema: {
        research_id: z
          .string()
          .describe("The research_id returned by kb_research or POST /research"),
      },
      annotations: READ_ONLY,
    },
    async ({ research_id }) => jsonResult(await tools.kbResearchResult(research_id)),
  );
}

function registerDigestTools(server: McpServer): void {
  server.registerTool(
    "kb_weekly_digest",
    {
      description:
        "Return the latest weekly newsletter digest, including cross-publication topic\n" +
        "threads, verified claims, and inline citations.\n\n" +
        "Fast read (<1s): queries the `digests` table in Postgres directly.",
      annotations: READ_ONLY,
    },
    async () => jsonResult(await tools.kbWeeklyDigest()),
  );
}

/** Build the MCP server with every tool registered. No transport: the caller connects one. */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerReadTools(server);
  registerStatusTools(server);
  registerIngestionTools(server);
  registerProvenanceTools(server);
  registerResearchTools(server);
  registerDigestTools(server);
  return server;
}

if (import.meta.main) {
  await createMcpServer().connect(new StdioServerTransport());
}
