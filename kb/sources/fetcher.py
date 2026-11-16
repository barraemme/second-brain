"""Article HTML fetch: robots.txt (cached per host), User-Agent, timeout, max size.

RSS entries may carry full content or only a summary — always fetch the
canonical URL here rather than trusting feed content.
"""

from __future__ import annotations

import urllib.robotparser
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx

from kb.config import settings
from kb.sources.url_guard import assert_public_url

_robots_cache: dict[str, urllib.robotparser.RobotFileParser] = {}


class FetchError(Exception):
    """robots.txt disallow or an oversized body — not retriable by re-fetching the same bytes."""


@dataclass
class FetchedPage:
    url: str
    html: str
    status_code: int


async def _get_robot_parser(host: str, scheme: str) -> urllib.robotparser.RobotFileParser:
    if host in _robots_cache:
        return _robots_cache[host]

    parser = urllib.robotparser.RobotFileParser()
    async with httpx.AsyncClient(
        headers={"User-Agent": settings.user_agent}, timeout=settings.request_timeout_s
    ) as client:
        response = await client.get(f"{scheme}://{host}/robots.txt")
    if response.status_code == 404:
        parser.parse([])  # no robots.txt at all -> nothing is disallowed
    else:
        response.raise_for_status()
        parser.parse(response.text.splitlines())

    _robots_cache[host] = parser
    return parser


async def _send_following_public_redirects(client: httpx.AsyncClient, url: str) -> httpx.Response:
    """GET `url` and follow redirects by hand, so the URL guard checks every hop.

    Returns an open streaming response: the caller must close it.
    """
    request = client.build_request("GET", url)
    for _ in range(settings.max_redirects + 1):
        await assert_public_url(str(request.url))
        response = await client.send(request, stream=True)
        if response.next_request is None:
            return response
        await response.aclose()
        request = response.next_request
    raise FetchError(f"More than {settings.max_redirects} redirects for {url!r}")


async def _read_capped_body(response: httpx.Response, url: str) -> str:
    body = bytearray()
    async for chunk in response.aiter_bytes():
        body.extend(chunk)
        if len(body) > settings.max_article_bytes:
            raise FetchError(
                f"Article exceeds max_article_bytes ({settings.max_article_bytes}): {url!r}"
            )
    return bytes(body).decode(response.encoding or "utf-8", errors="replace")


async def fetch_article(url: str) -> FetchedPage:
    """Fetch an article page. Raises `UnsafeUrlError` for any non-public hop, before any request."""
    await assert_public_url(url)
    parts = urlsplit(url)
    parser = await _get_robot_parser(parts.hostname or "", parts.scheme or "https")
    if not parser.can_fetch(settings.user_agent, url):
        raise FetchError(f"robots.txt disallows fetching {url!r}")

    async with httpx.AsyncClient(
        headers={"User-Agent": settings.user_agent}, timeout=settings.request_timeout_s
    ) as client:
        response = await _send_following_public_redirects(client, url)
        try:
            response.raise_for_status()
            html = await _read_capped_body(response, url)
        finally:
            await response.aclose()

    return FetchedPage(url=str(response.url), html=html, status_code=response.status_code)
