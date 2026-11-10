import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../config.js', () => ({
  CHAINS_API_DB_HOST: 'db.test', CHAINS_API_DB_PORT: 3306, CHAINS_API_DB_NAME: 'chains_api',
  CHAINS_API_DB_USER: 'chains_api', CHAINS_API_DB_PASSWORD: 'x'
}));

const { _setCreatePoolForTests } = await import('../../../src/store/database.js');
const { x402Ledger, memoryLedger } = await import('../../../src/auth/x402Ledger.js');

// A pool backed by a Map, answering the statements the ledger sends with MariaDB's semantics.
function fakePool() {
  const rows = new Map();
  const col = { status: 'status', tool: 'tool', args_hash: 'args_hash', tx_hash: 'tx_hash', updated_at: 'updated_at' };
  return {
    rows,
    query: vi.fn(async (sql, params = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('CREATE TABLE')) return {};
      if (s.startsWith('INSERT IGNORE INTO x402_payments')) {
        const [id, tool, argsHash, payloadHash, payer, nonce, network, asset, amount, payTo, validBefore, createdAt, updatedAt] = params;
        if (rows.has(id)) return { affectedRows: 0 };
        rows.set(id, { id, status: 'in_flight', tool, args_hash: argsHash, payload_hash: payloadHash, payer, nonce, network, asset, amount, pay_to: payTo, valid_before: validBefore, tx_hash: null, created_at: createdAt, updated_at: updatedAt });
        return { affectedRows: 1 };
      }
      if (s.startsWith('SELECT * FROM x402_payments WHERE id = ?')) return rows.has(params[0]) ? [{ ...rows.get(params[0]) }] : [];
      const update = s.match(/^UPDATE x402_payments SET (.+) WHERE id = \? AND status = \? AND updated_at = \?$/);
      if (update) {
        const names = update[1].split(', ').map(a => col[a.replace(' = ?', '')]);
        expect(names.every(Boolean)).toBe(true);
        const [id, status, updatedAt] = params.slice(names.length);
        const row = rows.get(id);
        if (!row || row.status !== status || row.updated_at !== updatedAt) return { affectedRows: 0 };
        names.forEach((n, i) => { row[n] = params[i]; });
        return { affectedRows: 1 };
      }
      if (s === "DELETE FROM x402_payments WHERE id = ? AND status = 'in_flight' AND updated_at = ?") {
        const row = rows.get(params[0]);
        if (row?.status === 'in_flight' && row.updated_at === params[1]) rows.delete(params[0]);
        return { affectedRows: 1 };
      }
      if (s === "DELETE FROM x402_payments WHERE status IN ('settled', 'refused') AND updated_at < ?") {
        for (const [id, r] of rows) if (['settled', 'refused'].includes(r.status) && r.updated_at < params[0]) rows.delete(id);
        return { affectedRows: 0 };
      }
      throw new Error(`unexpected ${s}`);
    }),
    end: vi.fn(async () => {})
  };
}

const REC = { id: 'p1', tool: 'echo', argsHash: 'h1', payloadHash: 'f1', payer: '0xpayer', nonce: '0xnonce', network: 'eip155:84532', asset: '0xusdc', amount: '1000', payTo: '0xdead', validBefore: 2_000_000_000, createdAt: 100 };

describe.each([
  ['memory', () => memoryLedger()],
  ['MariaDB', () => { _setCreatePoolForTests(async () => fakePool()); return x402Ledger(); }]
])('x402 ledger (%s)', (_name, make) => {
  let ledger;
  beforeEach(() => { ledger = make(); });

  it('claims a payment once', async () => {
    expect(await ledger.claim({ ...REC, id: `${_name}-a` })).toBe(true);
    expect(await ledger.claim({ ...REC, id: `${_name}-a` })).toBe(false);
    expect(await ledger.get(`${_name}-a`)).toMatchObject({ status: 'in_flight', tool: 'echo', argsHash: 'h1', payloadHash: 'f1', payer: '0xpayer', nonce: '0xnonce', amount: '1000', payTo: '0xdead', validBefore: 2_000_000_000, transaction: null, createdAt: 100, updatedAt: 100 });
    expect(await ledger.get('nope')).toBeNull();
  });

  it('changes a record only from the state it was read in', async () => {
    const id = `${_name}-b`;
    await ledger.claim({ ...REC, id });
    const rec = await ledger.get(id);
    expect(await ledger.transition(rec, { status: 'unresolved', transaction: '0xtx', updatedAt: 200 })).toBe(true);
    expect(await ledger.transition(rec, { status: 'settled', updatedAt: 300 })).toBe(false);
    const now = await ledger.get(id);
    expect(now).toMatchObject({ status: 'unresolved', transaction: '0xtx', updatedAt: 200 });
    expect(await ledger.transition(now, { status: 'in_flight', tool: 'other', argsHash: 'h2', updatedAt: 300 })).toBe(true);
    expect(await ledger.get(id)).toMatchObject({ status: 'in_flight', tool: 'other', argsHash: 'h2', transaction: '0xtx' });
  });

  it('releases only an in-flight claim as it was read, and purges old settled ones', async () => {
    await ledger.claim({ ...REC, id: `${_name}-c` });
    const claim = await ledger.get(`${_name}-c`);
    // Taken over by another call meanwhile: the old claim's release leaves the new one alone.
    await ledger.transition(claim, { status: 'in_flight', updatedAt: 150 });
    await ledger.release(claim);
    expect(await ledger.get(`${_name}-c`)).toMatchObject({ status: 'in_flight', updatedAt: 150 });
    await ledger.release(await ledger.get(`${_name}-c`));
    expect(await ledger.get(`${_name}-c`)).toBeNull();

    await ledger.claim({ ...REC, id: `${_name}-d` });
    const rec = await ledger.get(`${_name}-d`);
    await ledger.transition(rec, { status: 'settled', transaction: '0xtx', updatedAt: 500 });
    await ledger.release({ ...rec, status: 'settled', updatedAt: 500 });
    expect((await ledger.get(`${_name}-d`)).status).toBe('settled');
    await ledger.purge(400);
    expect(await ledger.get(`${_name}-d`)).not.toBeNull();
    await ledger.purge(600);
    expect(await ledger.get(`${_name}-d`)).toBeNull();
  });
});

describe('x402 ledger table', () => {
  it('is created on first use, not at startup with the other stores', async () => {
    // A fresh process: its own ledger and database modules.
    vi.resetModules();
    const db = await import('../../../src/store/database.js');
    const { x402Ledger } = await import('../../../src/auth/x402Ledger.js');
    const pool = fakePool();
    db._setCreatePoolForTests(async () => pool);
    await db.database();
    expect(pool.query.mock.calls.some(([sql]) => sql.includes('x402_payments'))).toBe(false);
    await x402Ledger().get('nope');
    const sqls = pool.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim());
    expect(sqls.filter(q => q.startsWith('CREATE TABLE IF NOT EXISTS x402_payments'))).toHaveLength(1);
    await x402Ledger().get('nope');
    expect(pool.query.mock.calls.filter(([sql]) => sql.includes('CREATE TABLE IF NOT EXISTS x402_payments'))).toHaveLength(1);
  });
});
