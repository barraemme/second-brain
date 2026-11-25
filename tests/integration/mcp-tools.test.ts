/**
 * Integration tests for the MCP tools.
 *
 * `kbSearch` runs against a real Postgres, rolled back per test
 * (`useRollbackDb`). `kbHealth` and `kbJobStatus` are deliberately left
 * unmocked: they exist to reflect live reachability of Postgres/the Inngest Dev
 * Server, so testing them against the real local dev stack is the point.
 * Skipped automatically if that stack isn't up.
 */

import { describe, expect, test } from "bun:test";
import { settings } from "../../kb/config";
import { replacePassages, upsertArticle, upsertPublication } from "../../kb/db/queries";
import * as tools from "../../kb/mcp/tools";
import { POSTGRES_AVAILABLE, useRollbackDb } from "./db";

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

describe.skipIf(!STACK_AVAILABLE)("MCP tools against the dev stack", () => {
  const db = useRollbackDb();

  test("kbHealth reports ok against the real dev stack", async () => {
    const result = await tools.kbHealth();
    expect(result.status).toBe("ok");
    expect(result.database).toBe("ok");
    expect(result.inngest).toBe("ok");
    expect(typeof result.articles).toBe("number");
    expect(typeof result.passages).toBe("number");
  });

  test("kbSearch finds a seeded passage", async () => {
    const publicationId = await upsertPublication(db(), {
      slug: "kb-search-test-pub",
      name: "Test Pub",
      feedUrl: "https://search-test.example.com/feed",
      homepage: "https://search-test.example.com",
    });
    const articleId = await upsertArticle(db(), {
      canonicalId: "pub:kb-search-test-pub:only-post",
      publicationId,
      url: "https://search-test.example.com/p/only-post",
      title: "A Post About Zebras",
      author: "Test Author",
      publishedAt: new Date("2026-01-01T00:00:00Z"),
      contentHash: "hash",
      text: "Zebras are fascinating striped animals found in Africa.",
    });
    await replacePassages(db(), {
      articleId,
      passages: [
        {
          chunk_index: 0,
          text: "Zebras are fascinating striped animals found in Africa.",
          embedding: null,
        },
      ],
    });

    const result = await tools.kbSearch("striped zebras Africa", 5);

    const searchResults = result.results as Record<string, unknown>[];
    expect(searchResults.length).toBeGreaterThanOrEqual(1);
    expect(searchResults.map((r) => r.title)).toContain("A Post About Zebras");
  });

  test("kbSearch does not error when nothing matches lexically", async () => {
    // On a populated dev database the dense leg still returns nearest neighbours,
    // so the contract is "a list, never an error", not "an empty list".
    const result = await tools.kbSearch("a query that matches absolutely nothing zzyzx", 5);
    expect(Array.isArray(result.results)).toBe(true);
  });

  test("kbJobStatus throws for an unknown event id", async () => {
    await expect(tools.kbJobStatus("not-a-real-event-id")).rejects.toThrow(
      "No job or Inngest run found",
    );
  });

  test("kbListPublications returns a list", async () => {
    const result = await tools.kbListPublications();
    expect(Array.isArray(result.publications)).toBe(true);
  });
});

describe("MCP tool input validation (no infrastructure)", () => {
  test("kbSources rejects a non-UUID id", async () => {
    await expect(tools.kbSources("not-a-uuid")).rejects.toThrow(
      "Invalid UUID for claim_or_passage_id='not-a-uuid'.",
    );
  });

  test("kbBackfill rejects a publication outside the allowlist", async () => {
    await expect(tools.kbBackfill("no-such-publication")).rejects.toThrow(
      "Publication 'no-such-publication' not found in publications.yaml allowlist.",
    );
  });
});
