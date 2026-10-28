import {
  CHAINS_API_DB_HOST,
  CHAINS_API_DB_PORT,
  CHAINS_API_DB_NAME,
  CHAINS_API_DB_USER,
  CHAINS_API_DB_PASSWORD
} from '../../config.js';
import { logger } from '../util/logger.js';

/**
 * RPC health in MariaDB: one row per chain, shared by every replica and kept across deploys.
 *
 * `results` is written when the chain's up/down state changes (rpcStateChanged), and `checked_at`
 * on every check, so a new pod both serves the last known statuses and knows which chains have
 * waited longest for a re-check. Times are epoch milliseconds, so no time-zone setting can shift
 * them. Every failure degrades to the file store (rpcHealthStore.js) rather than failing the app.
 */
const DDL = `CREATE TABLE IF NOT EXISTS rpc_health (
  chain_id   BIGINT PRIMARY KEY,
  results    LONGTEXT NOT NULL,
  changed_at BIGINT NOT NULL,
  checked_at BIGINT NOT NULL,
  INDEX idx_checked_at (checked_at)
)`;

let createPoolImpl = defaultCreatePool;
let pool = null;
let initPromise = null;
let lastWarnAt = 0;
let retryAt = 0;
const WARN_EVERY_MS = 60000;
// After a failed connect, the file store is used for this long before trying again — not on
// every chain check (about one a second).
const RETRY_AFTER_MS = 60000;

export function rpcHealthDbConfigured() {
  return Boolean(CHAINS_API_DB_HOST && CHAINS_API_DB_USER && CHAINS_API_DB_PASSWORD);
}

async function defaultCreatePool() {
  const mod = await import('mariadb');
  const mariadb = mod.default ?? mod;
  return mariadb.createPool({
    host: CHAINS_API_DB_HOST,
    port: CHAINS_API_DB_PORT,
    database: CHAINS_API_DB_NAME,
    user: CHAINS_API_DB_USER,
    password: CHAINS_API_DB_PASSWORD,
    connectionLimit: 3,
    acquireTimeout: 10000,
    connectTimeout: 5000,
    // BIGINT chain IDs and times come back as numbers, not BigInt.
    bigIntAsNumber: true
  });
}

/** The pool, with the table created; null when unconfigured or unreachable (warned once). */
export async function rpcHealthDb() {
  if (!rpcHealthDbConfigured()) return null;
  if (!initPromise && Date.now() < retryAt) return null;
  initPromise ??= (async () => {
    try {
      const p = await createPoolImpl();
      await p.query(DDL);
      pool = p;
      logger.info({ host: CHAINS_API_DB_HOST, database: CHAINS_API_DB_NAME }, 'RPC health stored in MariaDB');
      return p;
    } catch (err) {
      warn(err, 'RPC health database unavailable; using the file store');
      // Retry later rather than never, and not on every call meanwhile.
      retryAt = Date.now() + RETRY_AFTER_MS;
      initPromise = null;
      return null;
    }
  })();
  return initPromise;
}

function warn(err, msg) {
  if (Date.now() - lastWarnAt < WARN_EVERY_MS) return;
  lastWarnAt = Date.now();
  logger.warn({ err: err.message }, msg);
}

/**
 * Record one chain's check. Full results when `changed`; otherwise only `checked_at`, falling
 * back to a full row when the chain has none yet. Resolves false when the database could not
 * take it (the caller then keeps the file store current).
 */
export async function saveChainRpcHealthDb(chainId, results, { changed = true, checkedAt = Date.now() } = {}) {
  const db = await rpcHealthDb();
  if (!db) return false;
  try {
    if (!changed) {
      const r = await db.query('UPDATE rpc_health SET checked_at = ? WHERE chain_id = ?', [checkedAt, Number(chainId)]);
      if (Number(r?.affectedRows) > 0) return true;
    }
    await db.query(
      `INSERT INTO rpc_health (chain_id, results, changed_at, checked_at) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE results = VALUES(results), changed_at = VALUES(changed_at), checked_at = VALUES(checked_at)`,
      [Number(chainId), JSON.stringify(results), checkedAt, checkedAt]
    );
    return true;
  } catch (err) {
    warn(err, 'Failed to store RPC health in MariaDB');
    return false;
  }
}

/**
 * Every stored chain: { byChainId, checkedAtByChainId, lastCheckedAt }, or null when the
 * database is unconfigured or unreachable.
 */
export async function loadAllRpcHealthDb() {
  const db = await rpcHealthDb();
  if (!db) return null;
  try {
    const rows = await db.query('SELECT chain_id, results, checked_at FROM rpc_health');
    const byChainId = {};
    const checkedAtByChainId = {};
    let last = 0;
    for (const row of rows) {
      let results;
      try { results = JSON.parse(row.results); } catch { continue; }
      if (!Array.isArray(results)) continue;
      const id = Number(row.chain_id);
      const at = Number(row.checked_at);
      byChainId[id] = results;
      if (Number.isFinite(at) && at > 0) {
        checkedAtByChainId[id] = new Date(at).toISOString();
        if (at > last) last = at;
      }
    }
    return { byChainId, checkedAtByChainId, lastCheckedAt: last ? new Date(last).toISOString() : null };
  } catch (err) {
    warn(err, 'Failed to read RPC health from MariaDB');
    return null;
  }
}

export async function closeRpcHealthDb() {
  const p = pool;
  pool = null;
  initPromise = null;
  if (p) await p.end().catch(() => {});
}

export function _setCreatePoolForTests(fn) {
  createPoolImpl = fn ?? defaultCreatePool;
  pool = null;
  initPromise = null;
  lastWarnAt = 0;
  retryAt = 0;
}
