import { database, databaseConfigured, registerSchema } from '../store/database.js';

/**
 * Storage for licence keys and the OAuth 2.1 grants made with them. Only SHA-256 hashes of keys,
 * codes, tokens and client secrets are kept. Times are epoch seconds.
 *
 * Two implementations of one interface: MariaDB (production; shared by every pod and kept across
 * deploys) and memory (tests, and a local run without a database).
 */
registerSchema(
  `CREATE TABLE IF NOT EXISTS licence_keys (
    id         VARCHAR(36) PRIMARY KEY,
    name       VARCHAR(200) NOT NULL,
    key_hash   CHAR(64) NOT NULL UNIQUE,
    created_at BIGINT NOT NULL,
    revoked_at BIGINT NULL,
    used_at    BIGINT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_clients (
    id            VARCHAR(36) PRIMARY KEY,
    name          VARCHAR(100) NOT NULL,
    redirect_uris TEXT NOT NULL,
    auth_method   VARCHAR(32) NOT NULL,
    secret_hash   CHAR(64) NULL,
    created_at    BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_codes (
    hash           CHAR(64) PRIMARY KEY,
    client_id      VARCHAR(36) NOT NULL,
    redirect_uri   TEXT NOT NULL,
    resource       VARCHAR(255) NOT NULL,
    code_challenge VARCHAR(128) NOT NULL,
    key_id         VARCHAR(36) NOT NULL,
    expires_at     BIGINT NOT NULL,
    INDEX idx_codes_expiry (expires_at)
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_tokens (
    hash       CHAR(64) PRIMARY KEY,
    kind       VARCHAR(8) NOT NULL,
    grant_id   VARCHAR(36) NOT NULL,
    client_id  VARCHAR(36) NOT NULL,
    resource   VARCHAR(255) NOT NULL,
    key_id     VARCHAR(36) NOT NULL,
    expires_at BIGINT NOT NULL,
    INDEX idx_tokens_grant (grant_id),
    INDEX idx_tokens_expiry (expires_at)
  )`
);

export class StoreUnavailableError extends Error {
  constructor() { super('Licence and OAuth storage is unavailable'); }
}

function mariadbStore() {
  const db = async () => {
    const pool = await database();
    if (!pool) throw new StoreUnavailableError();
    return pool;
  };
  const one = async (sql, params) => (await (await db()).query(sql, params))[0] ?? null;
  const run = async (sql, params) => (await db()).query(sql, params);
  return {
    // ── licence keys ──
    createKey: k => run('INSERT INTO licence_keys (id, name, key_hash, created_at) VALUES (?, ?, ?, ?)', [k.id, k.name, k.keyHash, k.createdAt]),
    listKeys: async () => (await run('SELECT id, name, created_at, revoked_at, used_at FROM licence_keys ORDER BY created_at')).map(r => ({
      id: r.id, name: r.name, createdAt: Number(r.created_at), revokedAt: r.revoked_at == null ? null : Number(r.revoked_at), usedAt: r.used_at == null ? null : Number(r.used_at)
    })),
    revokeKey: async (id, at) => Number((await run('UPDATE licence_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [at, id])).affectedRows) > 0,
    activeKeyByHash: async hash => {
      const r = await one('SELECT id, name FROM licence_keys WHERE key_hash = ? AND revoked_at IS NULL', [hash]);
      return r ? { id: r.id, name: r.name } : null;
    },
    activeKey: async id => {
      const r = await one('SELECT id, name FROM licence_keys WHERE id = ? AND revoked_at IS NULL', [id]);
      return r ? { id: r.id, name: r.name } : null;
    },
    touchKey: (id, at) => run('UPDATE licence_keys SET used_at = ? WHERE id = ?', [at, id]),
    // ── clients ──
    countClients: async () => Number((await one('SELECT COUNT(*) AS n FROM oauth_clients'))?.n ?? 0),
    purgeUnusedClients: cutoff => run('DELETE FROM oauth_clients WHERE created_at < ? AND id NOT IN (SELECT client_id FROM oauth_tokens)', [cutoff]),
    createClient: c => run('INSERT INTO oauth_clients (id, name, redirect_uris, auth_method, secret_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [c.id, c.name, JSON.stringify(c.redirectUris), c.authMethod, c.secretHash, c.createdAt]),
    client: async id => {
      const r = await one('SELECT id, name, redirect_uris, auth_method, secret_hash FROM oauth_clients WHERE id = ?', [id]);
      return r ? { id: r.id, name: r.name, redirectUris: JSON.parse(r.redirect_uris), authMethod: r.auth_method, secretHash: r.secret_hash } : null;
    },
    // ── codes ──
    putCode: c => run('INSERT INTO oauth_codes (hash, client_id, redirect_uri, resource, code_challenge, key_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [c.hash, c.clientId, c.redirectUri, c.resource, c.codeChallenge, c.keyId, c.expiresAt]),
    // One use: read and delete together, so a second exchange finds nothing.
    takeCode: async hash => {
      const conn = await (await db()).getConnection();
      try {
        await conn.beginTransaction();
        const [r] = await conn.query('SELECT client_id, redirect_uri, resource, code_challenge, key_id, expires_at FROM oauth_codes WHERE hash = ? FOR UPDATE', [hash]);
        await conn.query('DELETE FROM oauth_codes WHERE hash = ?', [hash]);
        await conn.commit();
        return r ? { clientId: r.client_id, redirectUri: r.redirect_uri, resource: r.resource, codeChallenge: r.code_challenge, keyId: r.key_id, expiresAt: Number(r.expires_at) } : null;
      } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
      } finally { conn.release(); }
    },
    // ── tokens ──
    putTokens: async rows => { for (const t of rows) await run('INSERT INTO oauth_tokens (hash, kind, grant_id, client_id, resource, key_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [t.hash, t.kind, t.grantId, t.clientId, t.resource, t.keyId, t.expiresAt]); },
    token: async (hash, kind) => {
      const r = await one('SELECT grant_id, client_id, resource, key_id, expires_at FROM oauth_tokens WHERE hash = ? AND kind = ?', [hash, kind]);
      return r ? { grantId: r.grant_id, clientId: r.client_id, resource: r.resource, keyId: r.key_id, expiresAt: Number(r.expires_at) } : null;
    },
    deleteGrant: grantId => run('DELETE FROM oauth_tokens WHERE grant_id = ?', [grantId]),
    deleteExpired: async at => {
      await run('DELETE FROM oauth_tokens WHERE expires_at <= ?', [at]);
      await run('DELETE FROM oauth_codes WHERE expires_at <= ?', [at]);
    }
  };
}

export function memoryStore() {
  const keys = new Map(), clients = new Map(), codes = new Map(), tokens = new Map();
  return {
    createKey: async k => { keys.set(k.id, { ...k, revokedAt: null, usedAt: null }); },
    listKeys: async () => [...keys.values()].map(({ keyHash, ...k }) => k),
    revokeKey: async (id, at) => { const k = keys.get(id); if (!k || k.revokedAt) return false; k.revokedAt = at; return true; },
    activeKeyByHash: async hash => { const k = [...keys.values()].find(x => x.keyHash === hash && !x.revokedAt); return k ? { id: k.id, name: k.name } : null; },
    activeKey: async id => { const k = keys.get(id); return k && !k.revokedAt ? { id: k.id, name: k.name } : null; },
    touchKey: async (id, at) => { const k = keys.get(id); if (k) k.usedAt = at; },
    countClients: async () => clients.size,
    purgeUnusedClients: async cutoff => {
      const used = new Set([...tokens.values()].map(t => t.clientId));
      for (const [id, c] of clients) if (c.createdAt < cutoff && !used.has(id)) clients.delete(id);
    },
    createClient: async c => { clients.set(c.id, { ...c }); },
    client: async id => (clients.has(id) ? { ...clients.get(id) } : null),
    putCode: async c => { codes.set(c.hash, { ...c }); },
    takeCode: async hash => { const c = codes.get(hash) ?? null; codes.delete(hash); return c; },
    putTokens: async rows => { for (const t of rows) tokens.set(t.hash, { ...t }); },
    token: async (hash, kind) => { const t = tokens.get(hash); return t && t.kind === kind ? { ...t } : null; },
    deleteGrant: async grantId => { for (const [h, t] of tokens) if (t.grantId === grantId) tokens.delete(h); },
    deleteExpired: async at => {
      for (const [h, t] of tokens) if (t.expiresAt <= at) tokens.delete(h);
      for (const [h, c] of codes) if (c.expiresAt <= at) codes.delete(h);
    },
    // Tests only: what is stored, to check nothing but hashes is.
    _dump: () => ({ keys: [...keys.values()], clients: [...clients.values()], codes: [...codes.values()], tokens: [...tokens.values()] })
  };
}

let store = null;
/** The configured store: MariaDB when the database is configured, else memory. */
export function authStore() {
  store ??= databaseConfigured() ? mariadbStore() : memoryStore();
  return store;
}

export function _setAuthStoreForTests(s) { store = s; }
