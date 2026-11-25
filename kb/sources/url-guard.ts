/**
 * SSRF guard for pages outside the allowlist.
 *
 * `POST /articles` accepts any page, so the server must never fetch an address on
 * the local machine or the local network: Postgres, Adminer, the Inngest dev
 * server, Memgraph, or a cloud metadata endpoint. `fetchArticle` calls
 * `assertPublicUrl` before the first request and again on every redirect hop.
 */

import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";

const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:"]);

/** The URL is not a public http(s) address. Retrying never makes it safe. */
export class UnsafeUrlError extends Error {
  override name = "UnsafeUrlError";
}

// `scheme://` followed by a non-empty authority. WHATWG `URL` would read
// `https:///post` as host "post"; Python's urlsplit (and this check) sees no host.
const HAS_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]/i;

/** Lowercase hostname of `url` without IPv6 brackets, or "" when it has none. Pure. */
export function hostOf(url: string): string {
  if (!HAS_AUTHORITY.test(url)) return "";
  const hostname = URL.parse(url)?.hostname ?? "";
  return hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
}

// Non-global ranges, after Python's `ipaddress` `is_global` (IANA special-purpose
// registries), plus multicast. [network, prefix length].
const IPV4_BLOCKED: readonly [string, number][] = [
  ["0.0.0.0", 8], // "this network" / unspecified
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT (shared address space)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local: cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes 255.255.255.255 broadcast
];

const IPV6_BLOCKED: readonly [string, number][] = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b:1::", 48], // local-use IPv4/IPv6 translation
  ["100::", 64], // discard-only
  ["2001::", 23], // IETF protocol assignments (incl. Teredo)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["3fff::", 20], // documentation
  ["5f00::", 16], // segment routing
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8], // multicast
];

function ipv4ToBigInt(address: string): bigint {
  return address.split(".").reduce((acc, octet) => (acc << 8n) | BigInt(Number(octet)), 0n);
}

/** Expand an IPv6 address (with `::` and an optional dotted IPv4 tail) to its 8 groups. */
function ipv6Groups(address: string): number[] {
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(address)?.[1];
  let text = address;
  if (tail !== undefined) {
    const v4 = ipv4ToBigInt(tail);
    const high = Number(v4 >> 16n).toString(16);
    const low = Number(v4 & 0xffffn).toString(16);
    text = `${address.slice(0, -tail.length)}${high}:${low}`;
  }
  const [head = "", rest] = text.split("::");
  const headGroups = head ? head.split(":") : [];
  const restGroups = rest ? rest.split(":") : [];
  const missing = 8 - headGroups.length - restGroups.length;
  const zeros: string[] = rest === undefined ? [] : Array.from({ length: missing }, () => "0");
  return [...headGroups, ...zeros, ...restGroups].map((g) => Number.parseInt(g, 16));
}

function ipv6ToBigInt(address: string): bigint {
  const groups = ipv6Groups(address);
  if (groups.length !== 8) throw new Error(`Could not expand IPv6 address ${address}`);
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(group), 0n);
}

function inRanges(value: bigint, bits: bigint, ranges: readonly [string, number][]): boolean {
  const toBigInt = bits === 32n ? ipv4ToBigInt : ipv6ToBigInt;
  return ranges.some(([network, prefix]) => {
    const shift = bits - BigInt(prefix);
    return value >> shift === toBigInt(network) >> shift;
  });
}

const IPV4_MAPPED_PREFIX = 0xffffn << 32n; // ::ffff:0:0/96

/** True only for a globally routable IP (no loopback, private, link-local or reserved). */
export function isPublicIp(address: string): boolean {
  if (isIPv4(address)) return !inRanges(ipv4ToBigInt(address), 32n, IPV4_BLOCKED);
  // Zone ids (`fe80::1%en0`) are link-local by definition.
  if (!isIPv6(address) || address.includes("%")) return false;
  const value = ipv6ToBigInt(address);
  if (value >> 32n === IPV4_MAPPED_PREFIX >> 32n) {
    return !inRanges(value & 0xffffffffn, 32n, IPV4_BLOCKED);
  }
  return !inRanges(value, 128n, IPV6_BLOCKED);
}

/**
 * Throw `UnsafeUrlError` unless `url` is http(s) and its host resolves only to public IPs.
 *
 * A DNS failure throws the resolver's own error (`ENOTFOUND`, ...), which can be transient.
 */
export async function assertPublicUrl(url: string): Promise<void> {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase() ?? "";
  if (!ALLOWED_SCHEMES.has(`${scheme}:`)) {
    throw new UnsafeUrlError(`URL scheme must be http or https: ${JSON.stringify(url)}`);
  }
  if (!HAS_AUTHORITY.test(url)) throw new UnsafeUrlError(`URL has no host: ${JSON.stringify(url)}`);
  const host = hostOf(url);
  if (!host) throw new UnsafeUrlError(`URL has an invalid host or port: ${JSON.stringify(url)}`);

  // ponytail: check-then-connect, so DNS rebinding can still swap the IP before fetch
  // connects. Pin the resolved IP in a custom agent if the API is exposed beyond localhost.
  const infos = await lookup(host, { all: true });
  const addresses = [...new Set(infos.map((info) => info.address))];
  if (addresses.length === 0) throw new UnsafeUrlError(`Host ${host} resolved to no address`);
  const blocked = addresses.filter((address) => !isPublicIp(address)).sort();
  if (blocked.length > 0) {
    throw new UnsafeUrlError(
      `Host ${JSON.stringify(host)} resolves to non-public address(es) ${JSON.stringify(blocked)}: ${JSON.stringify(url)}`,
    );
  }
}
