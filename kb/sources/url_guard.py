"""SSRF guard for pages outside the allowlist.

`POST /articles` accepts any page, so the server must never fetch an address on
the local machine or the local network: Postgres, Adminer, the Inngest dev
server, Memgraph, or a cloud metadata endpoint. `fetch_article` calls
`assert_public_url` before the first request and again on every redirect hop.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit

_ALLOWED_SCHEMES = frozenset({"http", "https"})
_DEFAULT_PORTS = {"http": 80, "https": 443}


class UnsafeUrlError(ValueError):
    """The URL is not a public http(s) address. Retrying never makes it safe."""


def is_public_ip(address: str) -> bool:
    """True only for a globally routable IP (no loopback, private, link-local or reserved)."""
    ip = ipaddress.ip_address(address)
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_global


async def assert_public_url(url: str) -> None:
    """Raise `UnsafeUrlError` unless `url` is http(s) and its host resolves only to public IPs.

    A DNS failure raises `OSError` (`socket.gaierror`), which can be transient.
    """
    parts = urlsplit(url)
    if parts.scheme not in _ALLOWED_SCHEMES:
        raise UnsafeUrlError(f"URL scheme must be http or https: {url!r}")
    if not parts.hostname:
        raise UnsafeUrlError(f"URL has no host: {url!r}")
    try:
        port = parts.port or _DEFAULT_PORTS[parts.scheme]
    except ValueError as exc:
        raise UnsafeUrlError(f"URL has an invalid port: {url!r}") from exc

    # ponytail: check-then-connect, so DNS rebinding can still swap the IP before httpx
    # connects. Pin the resolved IP in a custom transport if the API is exposed beyond localhost.
    infos = await asyncio.get_running_loop().getaddrinfo(
        parts.hostname, port, type=socket.SOCK_STREAM
    )
    addresses = {str(info[4][0]) for info in infos}
    blocked = sorted(a for a in addresses if not is_public_ip(a))
    if blocked:
        raise UnsafeUrlError(
            f"Host {parts.hostname!r} resolves to non-public address(es) {blocked}: {url!r}"
        )
