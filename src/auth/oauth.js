import { createHash, randomUUID } from 'node:crypto';
import { authStore, StoreUnavailableError } from './store.js';
import { KEY_PATTERN, licenseeForKey, nowSeconds, secret, sha256, sameHash } from './licenceKeys.js';
import { TERMS_URL, LICENSING_CONTACT } from '../../config.js';

/**
 * OAuth 2.1 for the MCP endpoint, so remote connectors that need it (ChatGPT, claude.ai,
 * Claude Desktop) can connect. The service is both the authorization server and the resource
 * server. A connector registers itself (RFC 7591); a licensee approves it on the consent page by
 * pasting their licence key; the connector gets short-lived tokens for /mcp alone (RFC 8707
 * resource, PKCE S256 only, rotating refresh tokens). A grant lasts while its key is not revoked.
 * Discovery: RFC 9728 protected resource metadata, RFC 8414 authorization server metadata.
 * Enabled when PUBLIC_ORIGIN is set (src/http/app.js); ported from grocery-price-service.
 */
const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 86400;
const CODE_TTL = 120;
const MAX_CLIENTS = 200;
const UNUSED_CLIENT_TTL = 3600;
const SCOPE = 'mcp';
export const ACCESS_PATTERN = /^cao_[A-Za-z0-9_-]{43}$/;
const REFRESH_PATTERN = /^car_[A-Za-z0-9_-]{43}$/;
const PKCE_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'];
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export const mcpResource = origin => `${origin}/mcp`;
export const resourceMetadataUrl = origin => `${origin}/.well-known/oauth-protected-resource/mcp`;

class OAuthError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
class PageError extends Error {}

const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);

function form(body) {
  if (typeof body !== 'string') throw new OAuthError(400, 'invalid_request', 'Use application/x-www-form-urlencoded');
  const values = {};
  for (const [key, value] of new URLSearchParams(body)) {
    if (key in values) throw new OAuthError(400, 'invalid_request', `Repeated parameter ${key}`);
    values[key] = value;
  }
  return values;
}

// HTTPS anywhere, or HTTP on loopback for native apps (any port); no fragment or credentials.
function redirectUri(value) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value);
    if (url.hash || url.username || url.password || url.href !== value) return null;
    return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) ? value : null;
  } catch { return null; }
}

/**
 * Who a bearer token on /mcp belongs to: { keyId, licensee, via } or null. Either an OAuth
 * access token for this resource whose approving key is still active, or a licence key itself.
 */
export async function mcpBearer(header, origin, store = authStore()) {
  const raw = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (KEY_PATTERN.test(raw)) {
    const key = await licenseeForKey(raw, store);
    return key ? { keyId: key.id, licensee: key.name, via: 'key' } : null;
  }
  if (!ACCESS_PATTERN.test(raw)) return null;
  const token = await store.token(sha256(raw), 'access');
  if (!token || token.expiresAt <= nowSeconds() || token.resource !== mcpResource(origin)) return null;
  const key = await store.activeKey(token.keyId);
  return key ? { keyId: key.id, licensee: key.name, via: 'oauth' } : null;
}

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
function page(reply, status, body) {
  return reply.code(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('x-frame-options', 'DENY')
    .header('referrer-policy', 'same-origin')
    .header('cache-control', 'no-store')
    .header('content-security-policy', PAGE_CSP)
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chains — connect</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1d1d1f;background:#fff}h1{font-size:1.3rem}code,input{font-family:ui-monospace,monospace}
input[type=password]{width:100%;box-sizing:border-box;padding:.5rem;font-size:15px}button{padding:.5rem 1rem;font-size:15px;margin:1rem .5rem 0 0}.error{color:#b3261e}.dim{color:#666;font-size:14px}
@media (prefers-color-scheme:dark){body{color:#eee;background:#161616}.dim{color:#aaa}}</style></head><body>${body}</body></html>`);
}

export function registerOAuth(fastify, { origin, store = authStore(), rateLimits = {} } = {}) {
  const resource = mcpResource(origin);
  const limit = (max) => ({ config: { rateLimit: { max, timeWindow: 60000 } } });
  const oauthError = (reply, err) => reply.code(err.status).header('cache-control', 'no-store').send({ error: err.code, error_description: err.message });

  fastify.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 16384 }, (_req, body, done) => done(null, body));

  // ── discovery ──
  const resourceMetadata = async () => ({
    resource,
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Chains API',
    resource_documentation: TERMS_URL
  });
  fastify.get('/.well-known/oauth-protected-resource', { schema: { hide: true } }, resourceMetadata);
  fastify.get('/.well-known/oauth-protected-resource/mcp', { schema: { hide: true } }, resourceMetadata);
  fastify.get('/.well-known/oauth-authorization-server', { schema: { hide: true } }, async () => ({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [SCOPE],
    token_endpoint_auth_methods_supported: AUTH_METHODS,
    revocation_endpoint_auth_methods_supported: AUTH_METHODS,
    authorization_response_iss_parameter_supported: true,
    service_documentation: TERMS_URL
  }));

  // ── dynamic client registration (RFC 7591) ──
  // Anyone may register; a client is useless until a licensee approves it with a key, and a
  // registration unused for an hour is removed.
  fastify.post('/oauth/register', { schema: { hide: true }, ...limit(rateLimits.register ?? 20) }, async (request, reply) => {
    try {
      const metadata = request.body;
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new OAuthError(400, 'invalid_client_metadata', 'Send the client metadata as a JSON object');
      const uris = Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris.map(redirectUri) : [];
      if (!uris.length || uris.length > 5 || uris.some(u => !u)) throw new OAuthError(400, 'invalid_redirect_uri', 'Give 1-5 redirect_uris: HTTPS, or HTTP on localhost, with no fragment');
      const method = metadata.token_endpoint_auth_method ?? 'none';
      if (!AUTH_METHODS.includes(method)) throw new OAuthError(400, 'invalid_client_metadata', 'Unsupported token_endpoint_auth_method');
      for (const [key, allowed] of [['grant_types', ['authorization_code', 'refresh_token']], ['response_types', ['code']]]) {
        if (metadata[key] !== undefined && !(Array.isArray(metadata[key]) && metadata[key].every(v => allowed.includes(v)))) {
          throw new OAuthError(400, 'invalid_client_metadata', `Unsupported ${key}`);
        }
      }
      const name = typeof metadata.client_name === 'string' && metadata.client_name.trim() ? metadata.client_name.trim().slice(0, 100) : 'Unnamed MCP client';
      const id = randomUUID();
      const clientSecret = method === 'none' ? undefined : secret('cas_');
      const createdAt = nowSeconds();
      await store.purgeUnusedClients(createdAt - UNUSED_CLIENT_TTL);
      if (await store.countClients() >= MAX_CLIENTS) throw new OAuthError(400, 'invalid_client_metadata', 'Too many registered clients; try again later');
      await store.createClient({ id, name, redirectUris: uris, authMethod: method, secretHash: clientSecret ? sha256(clientSecret) : null, createdAt });
      return reply.code(201).header('cache-control', 'no-store').send({
        client_id: id, client_id_issued_at: createdAt,
        ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
        client_name: name, redirect_uris: uris, token_endpoint_auth_method: method,
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code']
      });
    } catch (err) {
      if (err instanceof OAuthError) return oauthError(reply, err);
      if (err instanceof StoreUnavailableError) return oauthError(reply, new OAuthError(503, 'temporarily_unavailable', err.message));
      throw err;
    }
  });

  // ── authorization and consent ──
  // Problems with the client or redirect URI are shown on the page and never redirected; the
  // rest go back to the client as OAuth errors.
  async function authorization(params) {
    const client = params.client_id ? await store.client(params.client_id) : null;
    if (!client) throw new PageError('Unknown connector. Add it again so it can register.');
    const redirect = params.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
    if (!redirect || !client.redirectUris.includes(redirect)) throw new PageError("The redirect URI doesn't match the connector's registration.");
    const state = params.state;
    const bad = (error, description) => ({ redirect, state, error, description });
    if (params.response_type !== 'code') return bad('unsupported_response_type', 'Only response_type=code is supported');
    if (params.code_challenge_method !== 'S256' || !PKCE_PATTERN.test(params.code_challenge ?? '')) return bad('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    if (state !== undefined && state.length > 1000) return bad('invalid_request', 'state is too long');
    // offline_access is implied: every grant gets a refresh token.
    const scopes = (params.scope ?? '').split(' ').filter(s => s && s !== 'offline_access');
    if (scopes.some(s => s !== SCOPE)) return bad('invalid_scope', `The only scope is ${SCOPE}`);
    if (params.resource !== undefined && params.resource !== resource) return bad('invalid_target', `resource must be ${resource}`);
    return { client, redirect, state, challenge: params.code_challenge };
  }
  const back = (reply, redirect, values) => {
    const url = new URL(redirect);
    for (const [key, value] of Object.entries({ ...values, iss: origin })) if (value !== undefined) url.searchParams.set(key, value);
    return reply.redirect(url.href, 302);
  };
  const consent = (req, error) => {
    const hidden = { response_type: 'code', client_id: req.client.id, redirect_uri: req.redirect, state: req.state, scope: SCOPE, resource, code_challenge: req.challenge, code_challenge_method: 'S256' };
    return `<h1>Allow ${escapeHtml(req.client.name)} to use the Chains API?</h1>
<p>It is asking for read access to chain data through <code>${escapeHtml(resource)}</code>, and will be sent back to <code>${escapeHtml(new URL(req.redirect).host)}</code>.</p>
<p>Only approve a connector you just added yourself. To approve, paste your <strong>licence key</strong> (<code>cak_…</code>). It is checked here and never shared with the connector, which gets its own tokens. Revoking the key later disconnects it.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}<form method="post" action="/oauth/authorize">${Object.entries(hidden).filter(([, v]) => v !== undefined).map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`).join('')}
<input type="password" name="key" autocomplete="off" aria-label="Licence key" placeholder="cak_…"><button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form>
<p class="dim">No key? Use is governed by the <a href="${escapeHtml(TERMS_URL)}">terms</a>; ask for one at ${escapeHtml(LICENSING_CONTACT)}.</p>`;
  };
  async function authorize(params, reply, decide) {
    let checked;
    try {
      checked = await authorization(params);
    } catch (err) {
      if (err instanceof PageError) return page(reply, 400, `<h1>Can't connect</h1><p>${escapeHtml(err.message)}</p>`);
      throw err;
    }
    if (checked.error) return back(reply, checked.redirect, { error: checked.error, error_description: checked.description, state: checked.state });
    if (!decide) return page(reply, 200, consent(checked));
    if (decide.decision !== 'approve') return back(reply, checked.redirect, { error: 'access_denied', error_description: 'The licensee denied access', state: checked.state });
    const key = await licenseeForKey(String(decide.key ?? '').trim(), store);
    if (!key) return page(reply, 401, consent(checked, "That isn't an active licence key."));
    const code = secret();
    await store.putCode({ hash: sha256(code), clientId: checked.client.id, redirectUri: checked.redirect, resource, codeChallenge: checked.challenge, keyId: key.id, expiresAt: nowSeconds() + CODE_TTL });
    return back(reply, checked.redirect, { code, state: checked.state });
  }
  const pageErrors = (reply, err) => {
    if (err instanceof OAuthError) return page(reply, 400, `<h1>Can't connect</h1><p>${escapeHtml(err.message)}</p>`);
    if (err instanceof StoreUnavailableError) return page(reply, 503, `<h1>Can't connect right now</h1><p>Try again in a minute.</p>`);
    throw err;
  };
  fastify.get('/oauth/authorize', { schema: { hide: true }, ...limit(rateLimits.authorize ?? 60) }, async (request, reply) => {
    try {
      const query = request.query ?? {};
      if (Object.values(query).some(Array.isArray)) return page(reply, 400, "<h1>Can't connect</h1><p>Repeated authorization parameters.</p>");
      return await authorize(query, reply);
    } catch (err) { return pageErrors(reply, err); }
  });
  // The consent form is the one request here that carries an Origin, and only our own.
  fastify.post('/oauth/authorize', { schema: { hide: true }, ...limit(rateLimits.authorize ?? 60) }, async (request, reply) => {
    try {
      const sent = request.headers.origin;
      if (sent !== undefined && sent !== origin) return page(reply, 403, "<h1>Can't connect</h1><p>This form can only be sent from this site.</p>");
      const { decision, key, ...params } = form(request.body);
      return await authorize(params, reply, { decision, key });
    } catch (err) { return pageErrors(reply, err); }
  });

  // ── tokens ──
  // A registered client, authenticated the way it registered.
  async function client(params, authorization) {
    let id = params.client_id;
    let given = params.client_secret;
    if (typeof authorization === 'string' && authorization.startsWith('Basic ')) {
      let user, password;
      try { [user, password] = Buffer.from(authorization.slice(6), 'base64').toString('utf8').split(':').map(decodeURIComponent); } catch { throw new OAuthError(401, 'invalid_client', 'Malformed Basic credentials'); }
      if (id && id !== user) throw new OAuthError(401, 'invalid_client', 'Conflicting client_id');
      id = user;
      given = password;
    }
    const found = id ? await store.client(id) : null;
    if (!found || (found.secretHash ? !given || !sameHash(sha256(given), found.secretHash) : given !== undefined)) {
      throw new OAuthError(401, 'invalid_client', 'Unknown client or wrong client credentials');
    }
    return found;
  }
  async function issue(grantId, clientId, keyId) {
    const access = secret('cao_');
    const refresh = secret('car_');
    const at = nowSeconds();
    await store.deleteExpired(at);
    await store.putTokens([
      { hash: sha256(access), kind: 'access', grantId, clientId, resource, keyId, expiresAt: at + ACCESS_TTL },
      { hash: sha256(refresh), kind: 'refresh', grantId, clientId, resource, keyId, expiresAt: at + REFRESH_TTL }
    ]);
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: SCOPE };
  }
  fastify.post('/oauth/token', { schema: { hide: true }, ...limit(rateLimits.token ?? 300) }, async (request, reply) => {
    try {
      const params = form(request.body);
      const found = await client(params, request.headers.authorization);
      const invalid = message => new OAuthError(400, 'invalid_grant', message);
      let result;
      if (params.grant_type === 'authorization_code') {
        // One use: the code is taken (deleted) before it is checked, so a failed exchange spends it.
        const code = await store.takeCode(sha256(params.code ?? ''));
        if (!code || code.expiresAt <= nowSeconds() || code.clientId !== found.id) throw invalid('Unknown, used or expired code');
        if (params.redirect_uri !== undefined && params.redirect_uri !== code.redirectUri) throw invalid("redirect_uri doesn't match the authorization request");
        if (params.resource !== undefined && params.resource !== code.resource) throw new OAuthError(400, 'invalid_target', "resource doesn't match the authorization request");
        if (!PKCE_PATTERN.test(params.code_verifier ?? '') || createHash('sha256').update(params.code_verifier).digest('base64url') !== code.codeChallenge) throw invalid('PKCE verification failed');
        if (!await store.activeKey(code.keyId)) throw invalid('The approving licence key was revoked');
        result = await issue(randomUUID(), found.id, code.keyId);
      } else if (params.grant_type === 'refresh_token') {
        // Rotation: the old refresh token and its access tokens end now.
        const row = REFRESH_PATTERN.test(params.refresh_token ?? '') ? await store.token(sha256(params.refresh_token), 'refresh') : null;
        if (!row || row.expiresAt <= nowSeconds() || row.clientId !== found.id) throw invalid('Unknown or expired refresh token');
        if ((params.scope !== undefined && params.scope !== SCOPE) || (params.resource !== undefined && params.resource !== row.resource)) throw new OAuthError(400, 'invalid_scope', "A refresh can't change the scope or resource");
        await store.deleteGrant(row.grantId);
        if (!await store.activeKey(row.keyId)) throw invalid('The approving licence key was revoked');
        result = await issue(row.grantId, found.id, row.keyId);
      } else {
        throw new OAuthError(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
      }
      return reply.header('cache-control', 'no-store').header('pragma', 'no-cache').send(result);
    } catch (err) {
      if (err instanceof OAuthError) return oauthError(reply, err);
      if (err instanceof StoreUnavailableError) return oauthError(reply, new OAuthError(503, 'temporarily_unavailable', err.message));
      throw err;
    }
  });
  // Revocation (RFC 7009) ends the whole grant: both tokens.
  fastify.post('/oauth/revoke', { schema: { hide: true }, ...limit(rateLimits.token ?? 300) }, async (request, reply) => {
    try {
      const params = form(request.body);
      const found = await client(params, request.headers.authorization);
      const raw = params.token ?? '';
      const row = (await store.token(sha256(raw), 'access')) ?? (await store.token(sha256(raw), 'refresh'));
      if (row && row.clientId === found.id) await store.deleteGrant(row.grantId);
      return reply.code(200).send({});
    } catch (err) {
      if (err instanceof OAuthError) return oauthError(reply, err);
      if (err instanceof StoreUnavailableError) return oauthError(reply, new OAuthError(503, 'temporarily_unavailable', err.message));
      throw err;
    }
  });
}
