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
 * Scope, stated honestly: this blocks LITERAL private addresses and internal-looking names. It
 * does NOT defeat DNS rebinding — a public hostname that resolves to 10.x still passes, because
 * stopping that needs resolve-then-pin at the socket layer. This closes the direct route, which
 * is the one a registry entry can take.
 */

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
