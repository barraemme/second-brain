/**
 * Unit tests for `POST /articles` accepting any public page.
 *
 * The URL guard (`kb/sources/url-guard.ts`) replaces the allowlist as the SSRF
 * protection for manual articles, and `fetchArticle` applies it on every redirect
 * hop. URLs use IP literals so that no test needs DNS or network access.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { PublicationEntry, publicationForManualUrl } from "../../kb/sources/allowlist";
import { FetchError, fetchArticle, robotsCache } from "../../kb/sources/fetcher";
import { assertPublicUrl, isPublicIp, UnsafeUrlError } from "../../kb/sources/url-guard";

const PUBLIC_HOST = "93.184.216.34";
const NEURAL_MAZE = PublicationEntry.parse({
  slug: "the-neural-maze",
  name: "The Neural Maze",
  feed_url: "https://theneuralmaze.com/feed",
  homepage: "https://www.theneuralmaze.com",
});

// --- 1. Which IPs count as public -------------------------------------------

test.each(["93.184.216.34", "2606:4700:4700::1111"])("public ip %s is allowed", (address) => {
  expect(isPublicIp(address)).toBe(true);
});

test.each([
  "127.0.0.1", // loopback: Postgres, Adminer, Inngest dev server
  "10.0.0.5", // private
  "192.168.1.10", // private
  "172.16.4.4", // private
  "169.254.169.254", // link-local: cloud metadata
  "100.64.0.1", // carrier-grade NAT
  "0.0.0.0", // unspecified
  "255.255.255.255", // broadcast
  "::", // IPv6 unspecified
  "::1", // IPv6 loopback
  "fe80::1", // IPv6 link-local
  "fd12:3456::1", // IPv6 unique local
  "::ffff:127.0.0.1", // IPv4-mapped loopback
  "::ffff:7f00:1", // IPv4-mapped loopback, hex form
  "not-an-ip",
])("non-public ip %s is blocked", (address) => {
  expect(isPublicIp(address)).toBe(false);
});

test("IPv4-mapped public address is allowed", () => {
  expect(isPublicIp("::ffff:93.184.216.34")).toBe(true);
});

// --- 2. The URL guard ---------------------------------------------------------

test("public url passes", async () => {
  await assertPublicUrl(`https://${PUBLIC_HOST}/blog/post`);
});

test.each([
  "http://127.0.0.1:5433/",
  "http://localhost:8081/",
  "http://169.254.169.254/latest/meta-data/",
  "http://[::1]/",
])("internal url %s is rejected", async (url) => {
  await expect(assertPublicUrl(url)).rejects.toThrow(UnsafeUrlError);
  await expect(assertPublicUrl(url)).rejects.toThrow("non-public");
});

test.each(["ftp://93.184.216.34/file", "file:///etc/passwd"])(
  "non-http scheme %s is rejected",
  async (url) => {
    await expect(assertPublicUrl(url)).rejects.toThrow("scheme");
  },
);

test("url without host is rejected", async () => {
  await expect(assertPublicUrl("https:///post")).rejects.toThrow("no host");
});

// --- 3. fetchArticle checks every redirect hop -------------------------------

type Route = () => Response;

/** Replace global fetch with a router; returns the list of requested URLs. */
function mockFetch(routes: Record<string, Route>): string[] {
  const calls: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    const route = routes[url];
    if (route === undefined) throw new Error(`unexpected fetch ${url}`);
    return route();
  }) as typeof fetch);
  return calls;
}

const redirect = (status: number, location: string): Route => {
  return () => new Response(null, { status, headers: { Location: location } });
};

describe("fetchArticle", () => {
  beforeEach(() => robotsCache.clear());
  afterEach(() => {
    (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
  });

  test("redirect to internal address is blocked", async () => {
    const calls = mockFetch({
      [`https://${PUBLIC_HOST}/robots.txt`]: () => new Response(null, { status: 404 }),
      [`https://${PUBLIC_HOST}/post`]: redirect(302, "http://127.0.0.1:8081/"),
      "http://127.0.0.1:8081/": () => new Response("internal"),
    });

    await expect(fetchArticle(`https://${PUBLIC_HOST}/post`)).rejects.toThrow(UnsafeUrlError);
    expect(calls).toContain(`https://${PUBLIC_HOST}/post`);
    expect(calls).not.toContain("http://127.0.0.1:8081/");
  });

  test("redirect to public address is followed", async () => {
    mockFetch({
      [`https://${PUBLIC_HOST}/robots.txt`]: () => new Response(null, { status: 404 }),
      [`https://${PUBLIC_HOST}/old`]: redirect(301, `https://${PUBLIC_HOST}/new`),
      [`https://${PUBLIC_HOST}/new`]: () => new Response("<html>ok</html>"),
    });

    const page = await fetchArticle(`https://${PUBLIC_HOST}/old`);

    expect(page.url).toBe(`https://${PUBLIC_HOST}/new`);
    expect(page.html).toBe("<html>ok</html>");
    expect(page.status_code).toBe(200);
  });

  test("redirect loop stops at the limit", async () => {
    mockFetch({
      [`https://${PUBLIC_HOST}/robots.txt`]: () => new Response(null, { status: 404 }),
      [`https://${PUBLIC_HOST}/loop`]: redirect(302, `https://${PUBLIC_HOST}/loop`),
    });

    await expect(fetchArticle(`https://${PUBLIC_HOST}/loop`)).rejects.toThrow(FetchError);
    await expect(fetchArticle(`https://${PUBLIC_HOST}/loop`)).rejects.toThrow("redirects");
  });

  test("robots.txt disallow is a FetchError", async () => {
    mockFetch({
      [`https://${PUBLIC_HOST}/robots.txt`]: () => new Response("User-agent: *\nDisallow: /p/"),
    });

    await expect(fetchArticle(`https://${PUBLIC_HOST}/p/post`)).rejects.toThrow("robots.txt");
  });

  test("oversized body is a FetchError", async () => {
    const { settings } = await import("../../kb/config");
    mockFetch({
      [`https://${PUBLIC_HOST}/robots.txt`]: () => new Response(null, { status: 404 }),
      [`https://${PUBLIC_HOST}/big`]: () => new Response("x".repeat(settings.maxArticleBytes + 1)),
    });

    await expect(fetchArticle(`https://${PUBLIC_HOST}/big`)).rejects.toThrow("max_article_bytes");
  });

  test("internal url is rejected before any request", async () => {
    const calls = mockFetch({});
    await expect(fetchArticle("http://127.0.0.1/post")).rejects.toThrow(UnsafeUrlError);
    expect(calls).toHaveLength(0);
  });
});

// --- 4. Publication for a manual article --------------------------------------

test("allowlisted host keeps its publication", () => {
  const pub = publicationForManualUrl("https://www.theneuralmaze.com/p/rag", [NEURAL_MAZE]);
  expect(pub.slug).toBe("the-neural-maze");
});

test("other host gets a web publication", () => {
  const url = "https://huggingface.co/blog/EmmaScharfmann/downscaling-a-weather-forecasting-model";
  const pub = publicationForManualUrl(url, [NEURAL_MAZE]);
  expect(pub.slug).toBe("web-huggingface-co");
  expect(pub.name).toBe("huggingface.co");
  expect(pub.homepage).toBe("https://huggingface.co");
  expect(pub.feed_url).toBe("");
});

test("url without host has no publication", () => {
  expect(() => publicationForManualUrl("not-a-url", [NEURAL_MAZE])).toThrow("no host");
});

// --- 5. POST /articles rejects unsafe URLs before any write --------------------

async function postArticle(url: string): Promise<Response> {
  const { app } = await import("../../kb/main");
  return app.request("/articles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

test.each([
  "http://127.0.0.1:5433/post",
  "http://169.254.169.254/latest",
  "ftp://93.184.216.34/post",
])("POST /articles rejects unsafe url %s", async (url) => {
  const response = await postArticle(url);
  expect(response.status).toBe(400);
});

test("POST /articles rejects url without path", async () => {
  const response = await postArticle(`https://${PUBLIC_HOST}/`);
  expect(response.status).toBe(400);
  const body = (await response.json()) as { detail?: string };
  expect(body.detail).toContain("no path segment");
});
