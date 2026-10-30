import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import Fastify from 'fastify';

vi.mock('../../../config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  RATE_LIMIT_WINDOW_MS: 60000,
  MCP_RATE_LIMIT_MAX: 1000,
  MCP_MAX_SESSIONS: 50,
  MCP_SESSION_IDLE_MS: 600000
}));
vi.mock('../../../dataService.js', () => ({
  initializeDataOnStartup: vi.fn(), startRpcHealthCheck: vi.fn(),
  getCachedData: () => ({ indexed: null, lastUpdated: null })
}));

import { memoryStore } from '../../../src/auth/store.js';
import { registerOAuth } from '../../../src/auth/oauth.js';
import { createLicenceKey, revokeLicenceKey } from '../../../src/auth/licenceKeys.js';
import { createMcpHttpApp } from '../../../mcp-server-http.js';

const ORIGIN = 'https://chains.test';
const REDIRECT = 'https://client.test/callback';
let store, api, mcp, server, mcpUrl;

beforeEach(async () => {
  store = memoryStore();
  api = Fastify({ logger: false });
  registerOAuth(api, { origin: ORIGIN, store });
  await api.ready();
  mcp = createMcpHttpApp({ publicOrigin: ORIGIN, authStore: store });
  server = await new Promise((resolve) => { const s = mcp.listen(0, '127.0.0.1', () => resolve(s)); });
  mcpUrl = `http://127.0.0.1:${server.address().port}/mcp`;
});
afterEach(async () => {
  mcp.locals.stopSweeper();
  for (const t of Object.values(mcp.locals.transports ?? {})) await t.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  await api.close();
});

const initialize = (headers = {}) => fetch(mcpUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
});
const formBody = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined)).toString();
const post = (url, payload, headers = {}) => api.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, payload: formBody(payload) });
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

async function register(extra = {}) {
  const res = await api.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'Claude <script>', redirect_uris: [REDIRECT], ...extra } });
  expect(res.statusCode).toBe(201);
  return res.json();
}
async function approve(client, key, { verifier, challenge } = pkce()) {
  const params = { response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, state: 's1', scope: 'mcp offline_access', resource: `${ORIGIN}/mcp`, code_challenge: challenge, code_challenge_method: 'S256' };
  const res = await post('/oauth/authorize', { ...params, decision: 'approve', key });
  return { res, verifier, params };
}
async function connect(key) {
  const client = await register();
  const { res, verifier } = await approve(client, key);
  const code = new URL(res.headers.location).searchParams.get('code');
  const tokens = await post('/oauth/token', { grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier, redirect_uri: REDIRECT, resource: `${ORIGIN}/mcp` });
  return { client, tokens: tokens.json(), code };
}

describe('MCP authorization', () => {
  it('refuses anonymous clients with the discovery pointer, and answers GET with 405', async () => {
    const res = await initialize();
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    const bad = await initialize({ authorization: `Bearer cao_${'x'.repeat(43)}` });
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect((await fetch(mcpUrl)).status).toBe(405);
  });

  it('publishes protected-resource and authorization-server metadata', async () => {
    const pr = (await api.inject({ url: '/.well-known/oauth-protected-resource/mcp' })).json();
    expect(pr).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN], scopes_supported: ['mcp'] });
    const as = (await api.inject({ url: '/.well-known/oauth-authorization-server' })).json();
    expect(as).toMatchObject({ issuer: ORIGIN, token_endpoint: `${ORIGIN}/oauth/token`, registration_endpoint: `${ORIGIN}/oauth/register`, code_challenge_methods_supported: ['S256'] });
  });

  it('runs the whole flow: register, consent with a licence key, PKCE exchange, MCP with the token', async () => {
    const { key } = await createLicenceKey('Acme Corp', store);
    const client = await register();
    // The consent page escapes the client name and cannot be framed.
    const { verifier, challenge } = pkce();
    const page = await api.inject({ url: `/oauth/authorize?${formBody({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp' })}` });
    expect(page.statusCode).toBe(200);
    expect(page.payload).toContain('Claude &#60;script&#62;');
    expect(page.payload).not.toContain('<script>');
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    // A wrong key is refused on the page; the right one redirects back with a code, state and iss.
    expect((await approve(client, 'cak_' + 'y'.repeat(43), { verifier, challenge })).res.statusCode).toBe(401);
    const { res } = await approve(client, key, { verifier, challenge });
    expect(res.statusCode).toBe(302);
    const back = new URL(res.headers.location);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('s1');
    expect(back.searchParams.get('iss')).toBe(ORIGIN);
    const code = back.searchParams.get('code');
    const tokens = await post('/oauth/token', { grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier, redirect_uri: REDIRECT });
    expect(tokens.statusCode).toBe(200);
    expect(tokens.json()).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp' });
    expect(tokens.json().access_token).toMatch(/^cao_/);
    // The code is single use.
    const again = await post('/oauth/token', { grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier });
    expect(again.json().error).toBe('invalid_grant');
    // The token opens MCP.
    expect((await initialize({ authorization: `Bearer ${tokens.json().access_token}` })).status).toBe(200);
  });

  it('spends a code on a failed PKCE check', async () => {
    const { key } = await createLicenceKey('Owner', store);
    const client = await register();
    const { res, verifier } = await approve(client, key);
    const code = new URL(res.headers.location).searchParams.get('code');
    expect((await post('/oauth/token', { grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: 'z'.repeat(43) })).json().error).toBe('invalid_grant');
    expect((await post('/oauth/token', { grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier })).json().error).toBe('invalid_grant');
  });

  it('rotates refresh tokens, and revoking the licence key disconnects its connectors only', async () => {
    const acme = await createLicenceKey('Acme Corp', store);
    const other = await createLicenceKey('Other Ltd', store);
    const a = await connect(acme.key);
    const b = await connect(other.key);
    const refreshed = await post('/oauth/token', { grant_type: 'refresh_token', client_id: a.client.client_id, refresh_token: a.tokens.refresh_token });
    expect(refreshed.statusCode).toBe(200);
    // The old pair is gone after rotation.
    expect((await initialize({ authorization: `Bearer ${a.tokens.access_token}` })).status).toBe(401);
    expect((await post('/oauth/token', { grant_type: 'refresh_token', client_id: a.client.client_id, refresh_token: a.tokens.refresh_token })).json().error).toBe('invalid_grant');
    expect((await initialize({ authorization: `Bearer ${refreshed.json().access_token}` })).status).toBe(200);
    // Revoke Acme's key: its tokens stop working, Other's keep working.
    expect(await revokeLicenceKey(acme.id, store)).toBe(true);
    expect((await initialize({ authorization: `Bearer ${refreshed.json().access_token}` })).status).toBe(401);
    expect((await post('/oauth/token', { grant_type: 'refresh_token', client_id: a.client.client_id, refresh_token: refreshed.json().refresh_token })).json().error).toBe('invalid_grant');
    expect((await initialize({ authorization: `Bearer ${b.tokens.access_token}` })).status).toBe(200);
  });

  it('accepts a licence key itself as a bearer token, until revoked', async () => {
    const { id, key } = await createLicenceKey('Script user', store);
    expect((await initialize({ authorization: `Bearer ${key}` })).status).toBe(200);
    await revokeLicenceKey(id, store);
    expect((await initialize({ authorization: `Bearer ${key}` })).status).toBe(401);
  });

  it('refuses foreign origins, bad redirect URIs and unknown clients without redirecting', async () => {
    const { key } = await createLicenceKey('Owner', store);
    expect((await initialize({ authorization: `Bearer ${key}`, origin: 'https://evil.test' })).status).toBe(403);
    const reg = await api.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: ['http://evil.test/cb'] } });
    expect(reg.json().error).toBe('invalid_redirect_uri');
    const unknown = await api.inject({ url: `/oauth/authorize?${formBody({ response_type: 'code', client_id: 'nope', redirect_uri: REDIRECT, code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' })}` });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.headers.location).toBeUndefined();
    const client = await register();
    const { params } = await approve(client, key);
    const foreign = await post('/oauth/authorize', { ...params, decision: 'approve', key }, { origin: 'https://evil.test' });
    expect(foreign.statusCode).toBe(403);
  });

  it('authenticates confidential clients and stores only hashes', async () => {
    const { key } = await createLicenceKey('Owner', store);
    const client = await register({ token_endpoint_auth_method: 'client_secret_basic' });
    expect(client.client_secret).toMatch(/^cas_/);
    const { res, verifier } = await approve(client, key);
    const code = new URL(res.headers.location).searchParams.get('code');
    const basic = 'Basic ' + Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64');
    const noSecret = await post('/oauth/token', { grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier });
    expect(noSecret.json().error).toBe('invalid_client');
    // The failed attempt did not take the code (client auth comes first), so the right one works.
    const tokens = await post('/oauth/token', { grant_type: 'authorization_code', code, code_verifier: verifier }, { authorization: basic });
    expect(tokens.statusCode).toBe(200);
    const stored = JSON.stringify(store._dump());
    for (const raw of [key, client.client_secret, tokens.json().access_token, tokens.json().refresh_token]) expect(stored).not.toContain(raw);
  });
});
