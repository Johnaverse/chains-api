import { isIP } from 'node:net';
import { RATE_LIMIT_CLIENT_IP_HEADER } from '../../config.js';

/**
 * The client a request is from, for per-client rate limits.
 *
 * Every public request arrives through Cloudflare -> the lab tunnel -> Envoy Gateway, so the TCP
 * peer is always the gateway pod: keyed on it, the limits were one bucket for every user (the
 * assistant's 10 a minute shared by the whole internet, `/reload`'s 5). Cloudflare puts the
 * visitor's address in RATE_LIMIT_CLIENT_IP_HEADER (`cf-connecting-ip`); it is used when it holds
 * a valid IP, else the TCP peer. Empty disables the header.
 */
export function clientKey(headers, remoteAddress) {
  const name = RATE_LIMIT_CLIENT_IP_HEADER;
  const raw = name ? headers?.[name] : null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const ip = typeof value === 'string' ? value.trim() : '';
  return isIP(ip) ? ip : (remoteAddress ?? 'unknown');
}
