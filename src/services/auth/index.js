import {
  AUTH_ENABLED,
  AUTH_ALLOWED_EMAILS,
  AUTH_APP_URL,
  AUTH_ALLOWED_ORIGINS,
  AUTH_STORE_FILE,
  AUTH_SESSION_TTL_DAYS,
  AUTH_COOKIE_SECURE,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM
} from '../../../config.js';
import { createAuthStore, normalizeEmail } from './store.js';
import { createChallengeService } from './challenges.js';
import { createMailer, createSmtpTransport } from './mailer.js';

/**
 * The auth context every surface shares — the /auth routes, and any route that needs to know
 * who is asking (GET /feedback). A module singleton, like the rest of this service's state,
 * with a test seam to swap it.
 */

/**
 * `a@x.io, @example.com` → exact addresses plus whole domains.
 * @param {string} raw
 */
export function parseAllowlist(raw) {
  const emails = new Set();
  const domains = [];
  for (const part of String(raw ?? '').split(',')) {
    const entry = normalizeEmail(part);
    if (!entry) continue;
    if (entry.startsWith('@')) domains.push(entry);
    else emails.add(entry);
  }
  return { emails, domains };
}

export function isAllowedEmail(email, allowlist) {
  const e = normalizeEmail(email);
  if (!e) return false;
  if (allowlist.emails.has(e)) return true;
  return allowlist.domains.some((d) => e.endsWith(d) && e.length > d.length);
}

/**
 * A deliberately conservative check, run before an address goes anywhere near the mailer.
 *
 * Mail libraries have repeatedly shipped parser bugs triggered by hostile address strings —
 * nodemailer's own advisories include an O(n²) address-list DoS and recipient-domain
 * bypasses via RFC 5322 comments. Allowing exactly one plain `local@domain.tld` shape, with no
 * comments, quotes, lists, display names or whitespace, keeps every one of those out.
 */
export function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const e = normalizeEmail(email);
  if (e.length < 3 || e.length > 254) return false;
  const m = /^([a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64})@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/.exec(e);
  if (!m) return false;
  const [, local] = m;
  return !local.startsWith('.') && !local.endsWith('.') && !local.includes('..');
}

/** The origin of the dashboard URL plus any extras — the browsers allowed to call /auth. */
export function allowedOrigins(appUrl, extra) {
  const set = new Set();
  const add = (u) => {
    try { set.add(new URL(u).origin); } catch { /* ignore malformed */ }
  };
  if (appUrl) add(appUrl);
  for (const part of String(extra ?? '').split(',')) if (part.trim()) add(part.trim());
  return set;
}

/**
 * @param {object} o
 * @returns {object} an auth context
 */
export function createAuth({
  enabled,
  allowlist,
  appUrl,
  origins,
  sessionTtlMs,
  cookieSecure,
  store,
  challenges,
  mailer
}) {
  const base = appUrl && !appUrl.endsWith('/') ? `${appUrl}/` : appUrl;
  return {
    enabled: Boolean(enabled),
    allowlist,
    origins,
    sessionTtlMs,
    cookieSecure,
    store,
    challenges,
    mailer,
    // Tokens travel in the URL FRAGMENT, not the query string. A fragment is never sent to a
    // server, so the token does not land in GitHub Pages' or a proxy's access logs, and it is
    // not leaked in a Referer header. The page moves it into memory and strips it at once.
    loginPageUrl: base ? `${base}login.html` : '',
    loginLink: (token) => `${base}login.html#verify=${token}`,
    resetLink: (token) => `${base}login.html#reset=${token}`,
    isAllowed: (email) => isAllowedEmail(email, allowlist)
  };
}

function authFromConfig() {
  if (!AUTH_ENABLED) {
    return createAuth({ enabled: false, allowlist: parseAllowlist(''), appUrl: '', origins: new Set() });
  }
  return createAuth({
    enabled: true,
    allowlist: parseAllowlist(AUTH_ALLOWED_EMAILS),
    appUrl: AUTH_APP_URL,
    origins: allowedOrigins(AUTH_APP_URL, AUTH_ALLOWED_ORIGINS),
    sessionTtlMs: AUTH_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    cookieSecure: AUTH_COOKIE_SECURE,
    store: createAuthStore({ file: AUTH_STORE_FILE }),
    challenges: createChallengeService(),
    mailer: createMailer({
      transport: createSmtpTransport({
        host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE, user: SMTP_USER, pass: SMTP_PASS
      }),
      from: SMTP_FROM
    })
  });
}

let current = null;

/**
 * Why accounts are not on, when an operator has clearly tried to turn them on. Silence is the
 * failure mode worth preventing: two of three variables set looks configured and behaves as
 * 404 everywhere.
 *
 * @param {Record<string, string>} [values] defaults to the live config
 * @returns {string[]} warnings, empty when auth is fully on or deliberately off
 */
export function authConfigProblems(values = { AUTH_ALLOWED_EMAILS, AUTH_APP_URL, SMTP_HOST }) {
  const missing = Object.entries(values).filter(([, v]) => !v).map(([k]) => k);
  const problems = [];
  if (missing.length > 0 && missing.length < Object.keys(values).length) {
    problems.push(`Accounts are partly configured: set ${missing.join(', ')} to enable sign-in. Until then every /auth route is 404.`);
  }
  if (values.AUTH_APP_URL) {
    let url = null;
    try { url = new URL(values.AUTH_APP_URL); } catch { /* reported below */ }
    if (!url) problems.push('AUTH_APP_URL is not a valid URL, so sign-in links would point nowhere.');
    else if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
      problems.push('AUTH_APP_URL is not https: sign-in links would travel, and open, unencrypted.');
    }
  }
  return problems;
}

/** The process-wide auth context, built from config on first use. */
export function getAuth() {
  if (!current) current = authFromConfig();
  return current;
}

/** Test-only: install a context (or null to rebuild from config next time). */
export function _setAuthForTests(auth) {
  current = auth;
}
