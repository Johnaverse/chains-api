import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConflictService, ConflictError } from '../../../../src/services/conflicts/index.js';
import { createReviewStore } from '../../../../src/services/conflicts/reviewStore.js';
import { conflictId } from '../../../../src/services/conflicts/identity.js';

const statusConflict = (chainsStatus = 'active') => ({
  rule: 5, chainId: 5, chainName: 'Goerli', type: 'status_conflict',
  message: 'Chain 5 (Goerli) has conflicting status across sources',
  statuses: [{ source: 'chainlist', status: 'deprecated' }, { source: 'chains', status: chainsStatus }]
});
const drift = (height) => ({
  rule: 12, chainId: 1, chainName: 'Ethereum', type: 'rpc_block_height_drift',
  message: `heights ${height} apart`, drift: height, threshold: 10,
  laggingEndpoint: { url: 'https://archive.example', blockHeight: 100 },
  leadingEndpoint: { url: 'https://fast.example', blockHeight: 100 + height }
});
const nameMismatch = { rule: 13, chainId: 56, chainName: 'BNB Smart Chain', type: 'name_disagreement', severity: 'info', message: 'names differ', chainsName: 'BNB Smart Chain', theGraphName: 'BSC' };

describe('conflict service', () => {
  let dir;
  let current;
  let svc;
  let store;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'conflicts-'));
    store = createReviewStore({ file: join(dir, 'reviews.json') });
    current = [statusConflict(), drift(40), nameMismatch];
    svc = createConflictService({ store, validate: () => ({ totalErrors: current.length, allErrors: current }) });
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const idOf = (c) => conflictId(c);

  describe('list', () => {
    it('shows open conflicts by default, with counts for every state and a per-rule breakdown', async () => {
      const r = await svc.list();
      expect(r.counts).toEqual({ open: 3, acknowledged: 0, dismissed: 0, resolved: 0, total: 3 });
      expect(r.items).toHaveLength(3);
      expect(r.byRule.map((b) => [b.rule, b.open, b.total])).toEqual([[5, 1, 1], [12, 1, 1], [13, 1, 1]]);
      const item = r.items.find((i) => i.rule === 12);
      expect(item).toMatchObject({ ruleLabel: 'RPC endpoints disagree on block height', state: 'open', review: null });
      expect(item.evidence.laggingEndpoint.url).toBe('https://archive.example');
      expect(item).not.toHaveProperty('raw');
    });

    it('filters by state, rule and search, while counts stay whole-set', async () => {
      await svc.review(idOf(nameMismatch), { state: 'dismissed', note: 'Common alias' }, 'a@x.io');
      expect((await svc.list({ state: 'dismissed' })).items.map((i) => i.rule)).toEqual([13]);
      expect((await svc.list({ state: 'all', rule: 5 })).items).toHaveLength(1);
      expect((await svc.list({ state: 'all', q: 'ethereum' })).items.map((i) => i.chainId)).toEqual([1]);
      expect((await svc.list({ state: 'all', q: '56' })).items.map((i) => i.chainId)).toEqual([56]);
      expect((await svc.list({ state: 'all', q: '   ' })).items).toHaveLength(3);
      const r = await svc.list({ state: 'dismissed' });
      expect(r.counts).toMatchObject({ open: 2, dismissed: 1, total: 3 });
    });

    it('pages, and reports how many matched in total', async () => {
      const r = await svc.list({ state: 'all', limit: 2, offset: 1 });
      expect(r.totalMatched).toBe(3);
      expect(r.items).toHaveLength(2);
      expect(r.items[0].rule).toBe(12); // sorted by rule
    });

    it('collapses duplicate findings into one item with an occurrence count', async () => {
      current = [statusConflict(), statusConflict()];
      const r = await svc.list();
      expect(r.items).toHaveLength(1);
      expect(r.items[0].occurrences).toBe(2);
    });

    it('answers 503 while the data has not loaded', async () => {
      const cold = createConflictService({ store, validate: () => ({ error: 'Data not loaded.' }) });
      await expect(cold.list()).rejects.toMatchObject({ status: 503 });
    });
  });

  describe('review', () => {
    it('acknowledges, recording who, when and why', async () => {
      const item = await svc.review(idOf(statusConflict()), { state: 'acknowledged', note: 'Reported to chainlist #123' }, 'owner@x.io');
      expect(item).toMatchObject({ state: 'acknowledged', review: { state: 'acknowledged', note: 'Reported to chainlist #123', by: 'owner@x.io' } });
      expect((await svc.list({ state: 'acknowledged' })).items).toHaveLength(1);
    });

    it('requires a reason to dismiss — hiding a conflict from everyone must say why', async () => {
      await expect(svc.review(idOf(nameMismatch), { state: 'dismissed', note: '   ' }, 'a@x.io')).rejects.toMatchObject({ status: 400 });
      await expect(svc.review(idOf(nameMismatch), { state: 'dismissed' }, 'a@x.io')).rejects.toBeInstanceOf(ConflictError);
    });

    it('reopens a decided conflict', async () => {
      await svc.review(idOf(nameMismatch), { state: 'dismissed', note: 'alias' }, 'a@x.io');
      const reopened = await svc.review(idOf(nameMismatch), { state: 'open', note: 'actually wrong' }, 'b@x.io');
      expect(reopened).toMatchObject({ state: 'open', review: null });
      expect((await svc.history()).map((h) => h.action)).toEqual(['reopened', 'dismissed']);
    });

    it('refuses an id that does not occur now — decisions are only ever about what an admin can see', async () => {
      await expect(svc.review('0'.repeat(20), { state: 'acknowledged' }, 'a@x.io')).rejects.toMatchObject({ status: 404 });
    });

    it('refuses an unknown state and an over-long note', async () => {
      await expect(svc.review(idOf(nameMismatch), { state: 'hidden' }, 'a@x.io')).rejects.toMatchObject({ status: 400 });
      await expect(svc.review(idOf(nameMismatch), { state: 'acknowledged', note: 'x'.repeat(1001) }, 'a@x.io')).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('decisions over time', () => {
    it('a dismissal of a lagging endpoint survives block heights moving every block', async () => {
      await svc.review(idOf(drift(40)), { state: 'dismissed', note: 'Archive node, lags by design' }, 'a@x.io');
      current = [statusConflict(), drift(57), nameMismatch]; // next refresh: new heights
      const r = await svc.list({ state: 'dismissed' });
      expect(r.items.map((i) => i.rule)).toEqual([12]);
      expect(r.counts.resolved).toBe(0);
    });

    it('a changed disagreement comes back OPEN, and the old decision shows as resolved', async () => {
      await svc.review(idOf(statusConflict('active')), { state: 'dismissed', note: 'chains is right' }, 'a@x.io');
      current = [statusConflict('incubating'), drift(40), nameMismatch]; // a source changed its value
      const r = await svc.list();
      expect(r.counts).toMatchObject({ open: 3, dismissed: 0, resolved: 1 });
      expect(r.resolved[0]).toMatchObject({ chainName: 'Goerli', state: 'dismissed', note: 'chains is right' });
    });

    it('a conflict fixed upstream shows as resolved, and prune clears it with an audit entry', async () => {
      await svc.review(idOf(nameMismatch), { state: 'acknowledged', note: 'reported' }, 'a@x.io');
      current = [statusConflict(), drift(40)]; // fixed upstream
      expect((await svc.list()).counts.resolved).toBe(1);
      expect(await svc.pruneResolved('b@x.io')).toBe(1);
      expect((await svc.list()).counts.resolved).toBe(0);
      expect((await svc.history())[0]).toMatchObject({ action: 'pruned', by: 'b@x.io', chainName: 'BNB Smart Chain' });
    });
  });

  describe('annotate — the public /validate view', () => {
    it('adds id and reviewState to each conflict, plus counts, without touching existing fields', async () => {
      await svc.review(idOf(nameMismatch), { state: 'dismissed', note: 'alias' }, 'a@x.io');
      const report = { totalErrors: 4, allErrors: [statusConflict(), statusConflict(), drift(40), nameMismatch] };
      const out = await svc.annotate(report);
      expect(out.totalErrors).toBe(4); // unchanged meaning
      expect(out.review).toEqual({ open: 2, acknowledged: 0, dismissed: 1 }); // distinct conflicts
      const byType = Object.fromEntries(out.allErrors.map((c) => [c.type, c]));
      expect(byType.name_disagreement.reviewState).toBe('dismissed');
      expect(byType.status_conflict.id).toMatch(/^[0-9a-f]{20}$/);
      // Notes and reviewers stay admin-only.
      expect(JSON.stringify(out)).not.toContain('alias');
      expect(JSON.stringify(out)).not.toContain('a@x.io');
    });

    it('passes an error report through untouched', async () => {
      const r = { error: 'Data not loaded.', errors: [] };
      expect(await svc.annotate(r)).toBe(r);
      expect(await svc.annotate(null)).toBeNull();
    });
  });
});
