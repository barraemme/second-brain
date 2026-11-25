/** Unit tests for three-way Reciprocal Rank Fusion (`kb/retrieval/hybrid.ts` & `graph.ts`). */

import { describe, expect, test } from "bun:test";
import { extractQuerySeedTopics } from "../../kb/retrieval/graph";
import { computeRrf } from "../../kb/retrieval/hybrid";

function candidateDict(
  pid: string,
  claim?: { claimId: string; claimText?: string; claimType?: string },
): Record<string, unknown> {
  const item: Record<string, unknown> = {
    passage_id: pid,
    text: `passage text for ${pid}`,
    title: `Article ${pid}`,
    author: "Test Author",
    url: `https://example.com/p/${pid}`,
    published_at: "2026-10-15T00:00:00+00:00",
    rank: 0.85,
  };
  if (claim !== undefined) {
    item.claim_id = claim.claimId;
    item.claim_text = claim.claimText ?? `Claim in ${pid}`;
    item.claim_type = claim.claimType ?? "opinion";
  }
  return item;
}

describe("computeRrf", () => {
  test("three-way RRF fuses BM25, vector and graph rankings", () => {
    const sparse = [candidateDict("P1"), candidateDict("P2")];
    const dense = [candidateDict("P2"), candidateDict("P3")];
    const graph = [
      candidateDict("P4", {
        claimId: "C4",
        claimText: "Graph-only claim",
        claimType: "measurement",
      }),
      candidateDict("P2", { claimId: "C2", claimText: "All-three claim", claimType: "opinion" }),
      candidateDict("P1", {
        claimId: "C1",
        claimText: "BM25+Graph claim",
        claimType: "prediction",
      }),
    ];

    const fused = computeRrf(sparse, dense, graph, 60);
    const byId = new Map(fused.map((c) => [c.passage_id, c]));
    const get = (pid: string) => {
      const cand = byId.get(pid);
      if (cand === undefined) throw new Error(`missing candidate ${pid}`);
      return cand;
    };

    // P2 appears in all 3 engines (rank 2 in sparse, rank 1 in dense, rank 2 in graph)
    const p2 = get("P2");
    expect(p2.source).toBe("all");
    expect([p2.sparse_rank, p2.dense_rank, p2.graph_rank]).toEqual([2, 1, 2]);
    expect(Math.abs(p2.rrf_score - (1 / 62 + 1 / 61 + 1 / 62))).toBeLessThan(1e-12);
    expect(p2.claim_id).toBe("C2");

    // P1 appears in sparse (#1) and graph (#3)
    const p1 = get("P1");
    expect(p1.source).toBe("bm25+graph");
    expect([p1.sparse_rank, p1.dense_rank, p1.graph_rank]).toEqual([1, null, 3]);

    // P4 appears only in graph (#1)
    const p4 = get("P4");
    expect(p4.source).toBe("graph");
    expect(p4.graph_rank).toBe(1);
    expect(p4.claim_id).toBe("C4");
    expect(p4.claim_type).toBe("measurement");

    // P3 appears only in dense (#2)
    const p3 = get("P3");
    expect(p3.source).toBe("vector");
    expect(p3.dense_rank).toBe(2);

    // P2 (3 engines) outranks P1 (2 engines), which outranks P4 and P3 (1 engine each)
    expect(fused.map((c) => c.passage_id)).toEqual(["P2", "P1", "P4", "P3"]);
  });

  test("a passage repeated inside one engine counts once, at its first rank", () => {
    const fused = computeRrf([candidateDict("P1"), candidateDict("P1")], [], null, 60);
    expect(fused).toHaveLength(1);
    expect(fused[0]?.rrf_score).toBe(1 / 61);
    expect(fused[0]?.source).toBe("bm25");
  });

  test("no results from any engine fuse to an empty list", () => {
    expect(computeRrf([], [], [], 60)).toEqual([]);
  });
});

describe("extractQuerySeedTopics", () => {
  test("normalizes aliases", () => {
    const [slugs] = extractQuerySeedTopics(
      "Which authors disagree on whether Retrieval-Augmented Generation " +
        "requires a reranker or RRF?",
    );
    expect(slugs).toContain("rag");
    expect(slugs).toContain("reranker");
    expect(slugs).toContain("reciprocal-rank-fusion");
  });

  test("a query of only stopwords yields no seeds", () => {
    expect(extractQuerySeedTopics("what is the")).toEqual([[], []]);
  });
});
