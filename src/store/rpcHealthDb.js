import { database, databaseConfigured, registerSchema, warnDatabase, closeDatabase, _setCreatePoolForTests as setPool } from './database.js';

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

registerSchema(DDL);

export function rpcHealthDbConfigured() {
  return databaseConfigured();
}

/** The shared pool (database.js); null when unconfigured or unreachable. */
export async function rpcHealthDb() {
  return database();
}

const warn = warnDatabase;

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
  await closeDatabase();
}

export function _setCreatePoolForTests(fn) {
  setPool(fn);
}
