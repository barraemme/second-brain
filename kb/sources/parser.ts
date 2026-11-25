/**
 * HTML -> clean text + metadata.
 *
 * Mozilla Readability (the Firefox Reader View engine) on a `linkedom` document
 * strips boilerplate (subscribe prompts, share buttons, footers) far more
 * reliably than a hand-rolled selector list. Its text is rebuilt block by block
 * so paragraphs stay separated by a blank line: chunking and the quote-span
 * guardrail both read this text.
 */

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { z } from "zod";

export const ParsedArticle = z.object({
  title: z.string(),
  author: z.string().nullable(),
  published_at: z.coerce.date(),
  text: z.string(),
  content_hash: z.string(),
});
export type ParsedArticle = z.infer<typeof ParsedArticle>;

/** The DOM surface this module reads; linkedom implements it. */
interface DomNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<DomNode>;
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
// Deeper than any real article; a hostile page cannot blow the stack.
const MAX_DOM_DEPTH = 256;
const BLOCK_BREAK = "\n\n";

const BLOCK_TAGS: ReadonlySet<string> = new Set(
  "ADDRESS ARTICLE ASIDE BLOCKQUOTE DD DIV DL DT FIGCAPTION FIGURE FOOTER H1 H2 H3 H4 H5 H6 HEADER HR LI MAIN OL P PRE SECTION TABLE TD TH TR UL".split(
    " ",
  ),
);

// Fallbacks for pages whose date Readability does not find (JSON-LD
// `datePublished`, `article:published_time` and `parsely-pub-date` are its own).
const DATE_SELECTORS: readonly [string, string][] = [
  ['meta[itemprop="datePublished"]', "content"],
  ['meta[name="date"]', "content"],
  ['meta[name="pubdate"]', "content"],
  ['meta[name="publish-date"]', "content"],
  ["time[datetime]", "datetime"],
];

export function hashText(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/**
 * Append the text of `node` to `out`, with a block break around every block element.
 * Source-formatting newlines become spaces, except inside `<pre>`.
 */
function collectText(node: DomNode, out: string[], depth: number, inPre: boolean): void {
  if (depth > MAX_DOM_DEPTH) throw new Error(`HTML nests deeper than ${MAX_DOM_DEPTH} elements`);
  if (node.nodeType === TEXT_NODE) {
    const text = node.textContent ?? "";
    out.push(inPre ? text : text.replace(/\s+/g, " "));
    return;
  }
  if (node.nodeType !== ELEMENT_NODE) return;
  if (node.nodeName === "BR") {
    out.push("\n");
    return;
  }
  const isBlock = BLOCK_TAGS.has(node.nodeName);
  if (isBlock) out.push(BLOCK_BREAK);
  const childInPre = inPre || node.nodeName === "PRE";
  for (const child of Array.from(node.childNodes)) collectText(child, out, depth + 1, childInPre);
  if (isBlock) out.push(BLOCK_BREAK);
}

/** Paragraphs separated by one blank line; whitespace inside a paragraph collapsed. Pure. */
export function normalizeArticleText(raw: string): string {
  return raw
    .split(/\n\s*\n/)
    .map((paragraph) =>
      paragraph
        .split("\n")
        .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
        .filter(Boolean)
        .join("\n"),
    )
    .filter(Boolean)
    .join("\n\n");
}

/** `published` as a UTC Date, or null when it does not parse. A zone-less time is UTC. */
function parseDate(published: string): Date | null {
  const trimmed = published.trim();
  const zoneless = /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(trimmed);
  const date = new Date(zoneless ? `${trimmed}Z` : trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

function metaDate(document: ReturnType<typeof parseHTML>["document"]): string | null {
  for (const [selector, attribute] of DATE_SELECTORS) {
    const value = document.querySelector(selector)?.getAttribute(attribute);
    if (value) return value;
  }
  return null;
}

/**
 * Extract title/author/date/body from a fetched article page.
 *
 * `fallbackPublishedAt` (the RSS feed's `pubDate`) is used only when the
 * page itself carries no extractable date. HTML metadata is preferred
 * because it reflects the article as actually published, not the feed
 * entry that triggered discovery.
 */
export function parseHtml(
  html: string,
  url: string,
  options: { fallbackPublishedAt: Date },
): ParsedArticle {
  const { document } = parseHTML(html);
  // Read before Readability runs: it mutates the document.
  const pageDate = metaDate(document);
  const article = new Readability<DomNode>(document, { serializer: (node) => node }).parse();

  const parts: string[] = [];
  if (article?.content) collectText(article.content, parts, 0, false);
  const text = normalizeArticleText(parts.join(""));
  if (!text)
    throw new Error(`readability could not extract any content from ${JSON.stringify(url)}`);

  const published = article?.publishedTime || pageDate;
  let publishedAt = options.fallbackPublishedAt;
  if (published) {
    const parsed = parseDate(published);
    if (parsed === null) console.warn(`parseHtml: ignoring unparseable date ${published} (${url})`);
    publishedAt = parsed ?? publishedAt;
  }

  return {
    title: article?.title?.trim() || url,
    author: article?.byline?.trim() || null,
    published_at: publishedAt,
    text,
    content_hash: hashText(text),
  };
}
