/**
 * Research and digest unit tests: Inngest functions (`run-research-agent`, `generate-weekly-digest`),
 * event schemas, `researchId()` generator, MCP tool registration (`kb_research`,
 * `kb_research_result`, `kb_weekly_digest`), and production deployment files.
 *
 * Runs with zero Docker containers or external API keys.
 */

import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parse as parseYaml } from "yaml";
import { loadSettings, settings } from "../kb/config";
import { FUNCTIONS } from "../kb/functions";
import { digestWindow, generateWeeklyDigest } from "../kb/functions/digest";
import { clampMaxIterations, runResearchAgent } from "../kb/functions/research";
import { client } from "../kb/inngest-client";
import { createMcpServer } from "../kb/mcp/server";
import {
  DIGEST_PUBLISHED,
  DIGEST_REQUESTED,
  DigestPublished,
  DigestRequested,
  RESEARCH_COMPLETED,
  RESEARCH_REQUESTED,
  ResearchCompleted,
  ResearchRequested,
} from "../kb/schemas/events";
import { researchId } from "../kb/schemas/ids";

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

test("research and digest functions are registered in the FUNCTIONS list", () => {
  const fnIds = new Set(FUNCTIONS.map((fn) => fn.id(client.id)));
  expect(fnIds.has("substack-brain-run-research-agent")).toBe(true);
  expect(fnIds.has("substack-brain-generate-weekly-digest")).toBe(true);
  expect(FUNCTIONS.length).toBe(9);
});

test("run-research-agent trigger and concurrency", () => {
  const triggers = runResearchAgent.opts.triggers ?? [];
  const events = new Set(triggers.map((t) => ("event" in t ? t.event : undefined)));
  expect(events).toEqual(new Set([RESEARCH_REQUESTED]));
  const concurrency = runResearchAgent.opts.concurrency;
  expect(Array.isArray(concurrency)).toBe(true);
  const first = Array.isArray(concurrency) ? concurrency[0] : undefined;
  expect(first?.limit).toBe(settings.concurrencyResearchRuns);
});

test("run-research-agent clamps max_iterations to 1..5", () => {
  expect(clampMaxIterations(99)).toBe(5);
  expect(clampMaxIterations(-3)).toBe(1);
  expect(clampMaxIterations(null)).toBe(Math.min(settings.researchMaxIterations, 5));
  expect(clampMaxIterations(0)).toBe(Math.min(settings.researchMaxIterations, 5));
});

test("generate-weekly-digest triggers on cron and event", () => {
  const triggers = generateWeeklyDigest.opts.triggers ?? [];
  expect(triggers.length).toBe(2);
  expect(triggers.some((t) => "cron" in t && t.cron === "0 8 * * 1")).toBe(true);
  expect(triggers.some((t) => "event" in t && t.event === DIGEST_REQUESTED)).toBe(true);

  // Verify Makefile-exported quoted cron strings are stripped before Inngest registration
  expect(loadSettings({ DIGEST_CRON: '"0 8 * * 1"' }).digestCron).toBe("0 8 * * 1");
});

test("digest window rounds to the hour and has a deterministic id per day pair", () => {
  const a = digestWindow(new Date("2026-11-16T08:27:13Z"), 7);
  const b = digestWindow(new Date("2026-11-16T08:59:59Z"), 7);
  expect(a.windowEnd.toISOString()).toBe("2026-11-16T08:00:00.000Z");
  expect(a.windowStart.toISOString()).toBe("2026-11-09T08:00:00.000Z");
  expect(a.title).toBe("The Substack Brain Weekly Digest (2026-11-09 to 2026-11-16)");
  expect(a.digestId).toBe(b.digestId);
  expect(digestWindow(new Date("2026-11-16T08:00:00Z"), 0).windowStart.toISOString()).toBe(
    "2026-11-15T08:00:00.000Z",
  );
});

test("research ids are prefixed and unique", () => {
  const ids = new Set(Array.from({ length: 100 }, () => researchId()));
  expect(ids.size).toBe(100);
  for (const id of ids) {
    expect(id.startsWith("res_")).toBe(true);
    expect(id.length).toBe(16);
  }
});

test("research and digest event schemas", () => {
  const req = ResearchRequested.parse({
    research_id: "res_abc123456789",
    question: "How does 3-way RRF compare to 2-way RRF?",
    max_iterations: 3,
    max_usd: 0.25,
  });
  expect(req).toEqual({
    research_id: "res_abc123456789",
    question: "How does 3-way RRF compare to 2-way RRF?",
    max_iterations: 3,
    max_usd: 0.25,
  });

  const comp = ResearchCompleted.parse({
    research_id: "res_abc123456789",
    status: "completed",
    iterations_used: 2,
    total_cost_usd: 0.0142,
    confidence: 1.0,
    failure_codes: [],
  });
  expect(comp.status).toBe("completed");
  expect(RESEARCH_COMPLETED).toBe("kb/research.completed");

  const dReq = DigestRequested.parse({ lookback_days: 7, publication_slugs: ["the-neural-maze"] });
  expect(dReq.lookback_days).toBe(7);

  const did = crypto.randomUUID();
  const now = new Date();
  const dPub = DigestPublished.parse({
    digest_id: did,
    window_start: now,
    window_end: now,
    article_count: 5,
    claim_count: 18,
    disagreements_count: 2,
  });
  expect(JSON.parse(JSON.stringify(dPub)).digest_id).toBe(did);
  expect(DIGEST_PUBLISHED).toBe("kb/digest.published");
});

test("MCP server registers all thirteen tools", async () => {
  const names = await listToolNames();
  expect(names).toContain("kb_research");
  expect(names).toContain("kb_research_result");
  expect(names).toContain("kb_weekly_digest");
  expect(names.length).toBe(13);
});

test("production deployment files exist and are valid", async () => {
  const dockerfile = Bun.file("Dockerfile");
  expect(await dockerfile.exists()).toBe(true);
  const content = await dockerfile.text();
  expect(content).toContain("bun run migrate");
  expect(content).toContain("bun kb/main.ts");

  const prodCompose = Bun.file("infra/docker-compose.prod.yml");
  expect(await prodCompose.exists()).toBe(true);
  const composeData = parseYaml(await prodCompose.text()) as {
    services: Record<string, { environment?: Record<string, string> }>;
  };
  const services = composeData.services;
  for (const name of ["postgres", "memgraph", "kb-app"])
    expect(Object.keys(services)).toContain(name);
  expect(services["kb-app"]?.environment?.INNGEST_DEV).toBe("false");
});
