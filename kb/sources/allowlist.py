"""publications.yaml is the allowlist. Ingestion refuses any URL outside it.

Pure functions, no I/O beyond reading the yaml file: unit-testable without
Inngest or a database. The `check-allowlist` step in `kb/functions/ingest.py`
calls `assert_allowed` and turns a `ValueError` into `inngest.NonRetriableError`.
"""

from __future__ import annotations

from pathlib import Path
from urllib.parse import urlsplit

import yaml
from pydantic import BaseModel

from kb.config import settings


class PublicationEntry(BaseModel):
    slug: str
    name: str
    feed_url: str
    homepage: str
    notes: str | None = None
    archive_urls: list[str] | None = None
    sitemap_url: str | None = None


def load_publications(path: str | Path | None = None) -> list[PublicationEntry]:
    """Read and validate `publications.yaml`."""
    file_path = Path(path or settings.publications_file)
    raw = yaml.safe_load(file_path.read_text())
    return [PublicationEntry.model_validate(entry) for entry in raw["publications"]]


def _host(url: str) -> str:
    return (urlsplit(url).hostname or "").lower()


def find_publication_for_url(
    url: str, publications: list[PublicationEntry]
) -> PublicationEntry | None:
    """Match a candidate article URL to an allowlisted publication by exact host.

    Exact match only — no subdomain wildcarding, no substring matching — so a
    lookalike host (`evil-theneuralmaze.example.com`) or an unlisted
    subdomain never passes.
    """
    host = _host(url)
    for pub in publications:
        allowed_hosts = {_host(pub.homepage), _host(pub.feed_url)}
        allowed_hosts.update(_host(u) for u in (pub.archive_urls or []))
        if pub.sitemap_url:
            allowed_hosts.add(_host(pub.sitemap_url))
        if host and host in allowed_hosts:
            return pub
    return None


def publication_for_manual_url(url: str, publications: list[PublicationEntry]) -> PublicationEntry:
    """The allowlisted publication for `url`, or a `web-<host>` publication for any other host.

    One publication per host keeps `canonical_id` stable and keeps `ingest-article`'s
    per-publication concurrency limit per website. A web publication has no feed, and
    the poller never sees it: `poll-feeds` reads only `publications.yaml`.
    """
    pub = find_publication_for_url(url, publications)
    if pub is not None:
        return pub
    host = _host(url)
    if not host:
        raise ValueError(f"URL has no host: {url!r}")
    return PublicationEntry(
        slug=f"web-{host.replace('.', '-')}",
        name=host,
        feed_url="",
        homepage=f"https://{host}",
    )


def assert_allowed(url: str, publications: list[PublicationEntry]) -> PublicationEntry:
    """Reject anything outside `publications.yaml`."""
    pub = find_publication_for_url(url, publications)
    if pub is None:
        raise ValueError(f"URL is outside the allowlist (publications.yaml): {url!r}")
    return pub
