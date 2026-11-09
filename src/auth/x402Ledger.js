import { database, databaseConfigured, registerSchema } from '../store/database.js';

/**
 * What became of each x402 payment (src/auth/x402.js), shared by every pod: a payment is claimed
 * before its tool runs, so it cannot run twice at once anywhere, and a settlement whose outcome
 * was lost is remembered, so a retry with the same payment recovers it instead of being asked to
 * pay again.
 *
 * status: in_flight (claimed: verifying, running or settling), unresolved (settlement outcome
 * unknown), settled (paid; `transaction` set), refused (will never be paid). Times are epoch ms.
 */
registerSchema(
  `CREATE TABLE IF NOT EXISTS x402_payments (
    id           CHAR(64) PRIMARY KEY,
    status       VARCHAR(12) NOT NULL,
    tool         VARCHAR(100) NOT NULL,
    args_hash    CHAR(64) NOT NULL,
    payer        VARCHAR(100) NULL,
    nonce        VARCHAR(80) NULL,
    network      VARCHAR(40) NOT NULL,
    asset        VARCHAR(100) NOT NULL,
    amount       VARCHAR(80) NOT NULL,
    pay_to       VARCHAR(100) NOT NULL,
    valid_before BIGINT NULL,
    tx_hash      VARCHAR(100) NULL,
    created_at   BIGINT NOT NULL,
    updated_at   BIGINT NOT NULL,
    INDEX idx_x402_updated (updated_at)
  )`
);

const COLUMNS = {
  status: 'status', tool: 'tool', argsHash: 'args_hash', transaction: 'tx_hash', updatedAt: 'updated_at'
};

function fromRow(r) {
  return {
    id: r.id, status: r.status, tool: r.tool, argsHash: r.args_hash, payer: r.payer, nonce: r.nonce,
    network: r.network, asset: r.asset, amount: r.amount, payTo: r.pay_to,
    validBefore: r.valid_before == null ? null : Number(r.valid_before),
    transaction: r.tx_hash, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at)
  };
}

export class LedgerUnavailableError extends Error {
  constructor() { super('x402 payment ledger is unavailable'); }
}

function mariadbLedger() {
  const run = async (sql, params) => {
    const pool = await database();
    if (!pool) throw new LedgerUnavailableError();
    return pool.query(sql, params);
  };
  return {
    /** Insert a new in-flight record; false when the payment is already known. */
    claim: async (rec) => Number((await run(
      `INSERT IGNORE INTO x402_payments (id, status, tool, args_hash, payer, nonce, network, asset, amount, pay_to, valid_before, tx_hash, created_at, updated_at)
       VALUES (?, 'in_flight', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [rec.id, rec.tool, rec.argsHash, rec.payer, rec.nonce, rec.network, rec.asset, rec.amount, rec.payTo, rec.validBefore, rec.createdAt, rec.createdAt]
    )).affectedRows) > 0,
    get: async (id) => {
      const [r] = await run('SELECT * FROM x402_payments WHERE id = ?', [id]);
      return r ? fromRow(r) : null;
    },
    /** Compare-and-set on (status, updatedAt): false when another call changed the record first. */
    transition: async (rec, fields) => {
      const sets = Object.keys(fields).map(k => `${COLUMNS[k]} = ?`);
      return Number((await run(
        `UPDATE x402_payments SET ${sets.join(', ')} WHERE id = ? AND status = ? AND updated_at = ?`,
        [...Object.values(fields), rec.id, rec.status, rec.updatedAt]
      )).affectedRows) > 0;
    },
    release: (id) => run(`DELETE FROM x402_payments WHERE id = ? AND status = 'in_flight'`, [id]),
    purge: (settledBefore) => run(`DELETE FROM x402_payments WHERE status IN ('settled', 'refused') AND updated_at < ?`, [settledBefore])
  };
}

export function memoryLedger() {
  const rows = new Map();
  return {
    claim: async (rec) => {
      if (rows.has(rec.id)) return false;
      rows.set(rec.id, { ...rec, status: 'in_flight', transaction: null, updatedAt: rec.createdAt });
      return true;
    },
    get: async (id) => (rows.has(id) ? { ...rows.get(id) } : null),
    transition: async (rec, fields) => {
      const cur = rows.get(rec.id);
      if (!cur || cur.status !== rec.status || cur.updatedAt !== rec.updatedAt) return false;
      rows.set(rec.id, { ...cur, ...fields });
      return true;
    },
    release: async (id) => { if (rows.get(id)?.status === 'in_flight') rows.delete(id); },
    purge: async (settledBefore) => {
      for (const [id, r] of rows) if ((r.status === 'settled' || r.status === 'refused') && r.updatedAt < settledBefore) rows.delete(id);
    }
  };
}

let ledger = null;
/** The configured ledger: MariaDB when the database is configured, else memory (one pod only). */
export function x402Ledger() {
  ledger ??= databaseConfigured() ? mariadbLedger() : memoryLedger();
  return ledger;
}
