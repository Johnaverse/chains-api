import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../config.js', () => ({
  CHAINS_API_DB_HOST: 'db.test', CHAINS_API_DB_PORT: 3306, CHAINS_API_DB_NAME: 'chains_api',
  CHAINS_API_DB_USER: 'chains_api', CHAINS_API_DB_PASSWORD: 'x'
}));

const { _setCreatePoolForTests, saveChainRpcHealthDb, loadAllRpcHealthDb, rpcHealthDbConfigured } = await import('../../../src/store/rpcHealthDb.js');

// A pool backed by a Map, answering the four statements the store sends.
function fakePool() {
  const rows = new Map();
  const queries = [];
  return {
    rows, queries,
    query: vi.fn(async (sql, params = []) => {
      queries.push(sql.trim().split(/\s+/)[0]);
      if (sql.startsWith('CREATE TABLE')) return {};
      if (sql.startsWith('UPDATE')) {
        const [checkedAt, id] = params;
        if (!rows.has(id)) return { affectedRows: 0 };
        rows.get(id).checked_at = checkedAt;
        return { affectedRows: 1 };
      }
      if (sql.startsWith('INSERT')) {
        const [id, results, changedAt, checkedAt] = params;
        rows.set(id, { chain_id: id, results, changed_at: changedAt, checked_at: checkedAt });
        return { affectedRows: 1 };
      }
      if (sql.startsWith('SELECT')) return [...rows.values()];
      throw new Error(`unexpected ${sql}`);
    }),
    end: vi.fn(async () => {})
  };
}

describe('rpcHealthDb', () => {
  let pool;
  beforeEach(() => { pool = fakePool(); _setCreatePoolForTests(async () => pool); });

  it('is configured by host, user and password', () => {
    expect(rpcHealthDbConfigured()).toBe(true);
  });

  it('writes results on a change, only the check time otherwise, and loads both back', async () => {
    const results = [{ url: 'https://rpc.one', ok: true }];
    expect(await saveChainRpcHealthDb(1, results, { changed: true, checkedAt: 1000 })).toBe(true);
    expect(await saveChainRpcHealthDb(1, [{ url: 'ignored' }], { changed: false, checkedAt: 2000 })).toBe(true);
    expect(pool.rows.get(1)).toMatchObject({ results: JSON.stringify(results), changed_at: 1000, checked_at: 2000 });
    const loaded = await loadAllRpcHealthDb();
    expect(loaded.byChainId[1]).toEqual(results);
    expect(loaded.checkedAtByChainId[1]).toBe(new Date(2000).toISOString());
    expect(loaded.lastCheckedAt).toBe(new Date(2000).toISOString());
  });

  it('writes the full row when an unchanged chain has none stored yet', async () => {
    await saveChainRpcHealthDb(7, [{ url: 'a', ok: false }], { changed: false, checkedAt: 5 });
    expect(pool.rows.get(7)).toMatchObject({ checked_at: 5, changed_at: 5 });
  });

  it('degrades to null / false when the database is unreachable', async () => {
    _setCreatePoolForTests(async () => { throw new Error('ECONNREFUSED'); });
    expect(await saveChainRpcHealthDb(1, [], { changed: true })).toBe(false);
    expect(await loadAllRpcHealthDb()).toBeNull();
  });
});
