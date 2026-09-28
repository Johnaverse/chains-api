/**
 * Session cookies and request authentication.
 *
 * The session is an HttpOnly cookie, not a bearer token in localStorage: script on the page
 * cannot read an HttpOnly cookie, so an XSS bug cannot exfiltrate the session. SameSite=Lax
 * keeps the browser from attaching it to cross-site POSTs, which is half of the CSRF defence;
 * the Origin check in the auth routes is the other half.
 *
 * SameSite=Lax is also a deployment constraint: the dashboard and the API must share a
 * registrable domain (www.johnaverse.cc and chains-api.johnaverse.cc do), or the browser will
 * not send the cookie on the dashboard's cross-origin requests.
 *
 * Parsed and serialized by hand — two small functions — rather than adding @fastify/cookie for
 * one cookie.
 */

export const SESSION_COOKIE = 'chains_session';

/** @returns {Record<string, string>} */
export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || !header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name || name in out) continue; // first occurrence wins, as browsers send most specific first
    let value = part.slice(i + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try { out[name] = decodeURIComponent(value); } catch { out[name] = value; }
  }
  return out;
}

function cookie(name, value, { maxAgeSec, secure }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function sessionCookie(token, { ttlMs, secure }) {
  return cookie(SESSION_COOKIE, token, { maxAgeSec: Math.floor(ttlMs / 1000), secure });
}

export function clearSessionCookie({ secure }) {
  return cookie(SESSION_COOKIE, '', { maxAgeSec: 0, secure });
}

export function sessionTokenFrom(request) {
  return parseCookies(request.headers?.cookie)[SESSION_COOKIE] || null;
}

/**
 * The signed-in user for a request, or null. Never throws: a broken store must read as
 * "not signed in", not as a 500 on every protected route.
 *
 * @returns {Promise<{session: object, user: object, token: string}|null>}
 */
export async function readSession(request, auth) {
  if (!auth?.enabled) return null;
  const token = sessionTokenFrom(request);
  if (!token) return null;
  try {
    const found = await auth.store.getSession(token);
    return found ? { ...found, token } : null;
  } catch {
    return null;
  }
}

/** The fields of a user it is safe to send to the browser. */
export function publicUser(user) {
  return {
    email: user.email,
    hasPassword: Boolean(user.passwordHash),
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt ?? null
  };
}

/**
 * CSRF, the other half (SameSite=Lax on the session cookie is the first). A browser always
 * sends Origin on a cross-origin POST; one from a page we do not trust is refused. A request
 * with no Origin is a non-browser client — curl, a script — and CSRF is not a risk there,
 * since it has no victim cookie jar to ride on. Shared by every cookie-authenticated route.
 */
export function originAllowed(request, auth) {
  const origin = request.headers.origin;
  if (!origin) return request.headers['sec-fetch-site'] !== 'cross-site';
  if (auth.origins.has(origin)) return true;
  try {
    // Parse the Host through the same scheme so default ports compare equal on both sides:
    // URL('http://h:80').host is 'h', while a Host header may still say 'h:80'.
    const o = new URL(origin);
    return new URL(`${o.protocol}//${request.headers.host}`).host === o.host;
  } catch {
    return false;
  }
}
