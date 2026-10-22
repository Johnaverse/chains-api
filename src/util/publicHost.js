/**
 * Is a hostname safe to make an outbound request to?
 *
 * This service fetches URLs that come from the chain registry — RPC endpoints and block
 * explorers sourced from chains.json, a community-maintained list anyone can submit a chain to.
 * Those URLs are attacker-influenceable INPUT, not configuration, and several paths that use
 * them are reachable on demand through the assistant. Without a host check, a crafted entry
 * like `http://10.43.0.1:8080/blockscout` turns a read-only lookup into an internal port
 * scanner running inside the cluster.
 *
 * Lives here rather than beside either caller because both the halt check and the explorer
 * client need it, and neither owns it. (It also keeps the rule out of modules that tests
 * routinely mock — importing it from a mocked module made the guard vanish under test.)
 *
 * Scope, stated honestly: `safeExternalUrl` blocks LITERAL private addresses and
 * internal-looking names. `resolvesPublic` closes the next route — a public-looking name whose
 * DNS answers a private address — by resolving before the request. It does NOT defeat DNS
 * rebinding (a name that answers differently between our lookup and the socket's), which needs
 * resolve-then-pin at the socket layer.
 */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const PRIVATE_HOST = /^(?:localhost|.*\.local|.*\.internal|.*\.localdomain|.*\.svc(?:\.cluster\.local)?)$/i;

// 10/8, 127/8, 0/8, 169.254/16 (link-local, incl. cloud metadata), 192.168/16, 172.16-31/12.
const PRIVATE_V4 = /^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

export function isPubliclyRoutable(hostname) {
  if (typeof hostname !== 'string' || !hostname) return false;
  // URL parsing leaves IPv6 literals bracketed.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (PRIVATE_HOST.test(host)) return false;
  if (PRIVATE_V4.test(host)) return false;
  // IPv6 loopback, link-local (fe80::/10) and unique-local (fc00::/7).
  if (host === '::1' || host.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/.test(host)) return false;
  // A name with no dot cannot be a public DNS name, but is exactly how in-cluster services are
  // addressed ("chains-api", "litellm").
  if (!host.includes('.')) return false;
  return true;
}

/**
 * Parse a URL and accept it only if it is http(s) to a publicly routable host.
 * @returns {URL|null}
 */
export function safeExternalUrl(url) {
  if (typeof url !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  return isPubliclyRoutable(parsed.hostname) ? parsed : null;
}

// Every address range that is not the public internet, for resolved addresses.
const NON_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]
]) NON_PUBLIC.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) {
  NON_PUBLIC.addSubnet(net, prefix, 'ipv6');
}

/** Whether an IP address (v4, v6, or v4-mapped v6) is on the public internet. */
export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 0) return false;
  const mapped = family === 6 ? /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address) : null;
  if (mapped) return !NON_PUBLIC.check(mapped[1], 'ipv4');
  return !NON_PUBLIC.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

const RESOLVED_TTL_MS = 10 * 60 * 1000;
const resolved = new Map(); // hostname -> { ok, at }

/**
 * Resolve a URL's host and accept it only if EVERY address it answers is public. A host that
 * does not resolve is not refused here: the request fails on its own, and the RPC monitor
 * records it as unreachable. Cached for ten minutes per host, since the RPC sweep asks about
 * the same hosts over and over.
 * @returns {Promise<boolean>}
 */
export async function resolvesPublic(url, { now = Date.now(), resolve = lookup } = {}) {
  const parsed = safeExternalUrl(url);
  if (!parsed) return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return isPublicAddress(host);
  const hit = resolved.get(host);
  if (hit && now - hit.at < RESOLVED_TTL_MS) return hit.ok;
  let ok;
  try {
    const addresses = await resolve(host, { all: true, verbatim: true });
    ok = addresses.every(({ address }) => isPublicAddress(address));
  } catch {
    return true;
  }
  if (resolved.size > 20000) resolved.clear();
  resolved.set(host, { ok, at: now });
  return ok;
}

export function _resetResolvedForTests() {
  resolved.clear();
}
