/** Unit tests for `kb/sources/parser.ts` (Readability on linkedom) with an inline HTML page. */

import { expect, test } from "bun:test";
import { hashText, normalizeArticleText, parseHtml } from "../../kb/sources/parser";

const FALLBACK = new Date("2025-01-01T00:00:00Z");
const PARAGRAPH =
  "Reciprocal Rank Fusion combines BM25 lexical search and pgvector cosine similarity " +
  "without requiring score calibration, which is why it is the default fusion method.";

function page(head: string): string {
  return `<!doctype html><html><head><title>RRF in practice | The Neural Maze</title>${head}</head>
<body>
  <nav><a href="/">Home</a> <a href="/archive">Archive</a></nav>
  <article>
    <h1>RRF in practice</h1>
    <p>${PARAGRAPH}</p>
    <p>When nothing has changed, origins return
       304 Not Modified with 0 body bytes, and the polling run finishes in under 15ms.
       ${"Conditional requests keep the poller cheap. ".repeat(8)}</p>
    <pre>const k = 60;
score += 1 / (k + rank);</pre>
  </article>
  <footer>Subscribe now! Share this post.</footer>
</body></html>`;
}

const META = `<meta property="article:published_time" content="2025-09-16T09:48:40+02:00">
<meta name="author" content="Miguel Otero Pedrido">`;

test("article text keeps paragraphs separated by blank lines", () => {
  const parsed = parseHtml(page(META), "https://example.com/p/rrf", {
    fallbackPublishedAt: FALLBACK,
  });

  const paragraphs = parsed.text.split("\n\n");
  expect(paragraphs).toContain(PARAGRAPH);
  // Source-formatting newlines inside a <p> become single spaces.
  expect(parsed.text).toContain("origins return 304 Not Modified with 0 body bytes");
  // <pre> keeps its line breaks.
  expect(parsed.text).toContain("const k = 60;\nscore += 1 / (k + rank);");
  expect(parsed.text).not.toContain("Subscribe now");
  expect(parsed.text).not.toMatch(/\n{3,}/);
  expect(parsed.content_hash).toBe(hashText(parsed.text));
});

test("title, author and page date come from the HTML metadata", () => {
  const parsed = parseHtml(page(META), "https://example.com/p/rrf", {
    fallbackPublishedAt: FALLBACK,
  });

  expect(parsed.title).toContain("RRF in practice");
  expect(parsed.author).toBe("Miguel Otero Pedrido");
  expect(parsed.published_at.toISOString()).toBe("2025-09-16T07:48:40.000Z");
});

test("JSON-LD and zone-less dates are read as UTC", () => {
  const jsonLd = `<script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Article","datePublished":"2025-09-16T09:48:40"}
  </script>`;
  const parsed = parseHtml(page(jsonLd), "https://example.com/p/rrf", {
    fallbackPublishedAt: FALLBACK,
  });
  expect(parsed.published_at.toISOString()).toBe("2025-09-16T09:48:40.000Z");
});

test("the feed date is used when the page carries none", () => {
  const parsed = parseHtml(page(""), "https://example.com/p/rrf", {
    fallbackPublishedAt: FALLBACK,
  });
  expect(parsed.published_at).toEqual(FALLBACK);
  expect(parsed.author).toBeNull();
});

test("a page without content is an error", () => {
  expect(() =>
    parseHtml("<html><body></body></html>", "https://example.com/empty", {
      fallbackPublishedAt: FALLBACK,
    }),
  ).toThrow("could not extract any content");
});

test("normalizeArticleText collapses blank-line runs and inline whitespace", () => {
  expect(normalizeArticleText("\n\n  a   b \n\n\n\n c\t d \n e  \n\n")).toBe("a b\n\nc d\ne");
});
