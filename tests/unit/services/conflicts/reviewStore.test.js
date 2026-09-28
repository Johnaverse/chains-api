import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewStore, STATES } from '../../../../src/services/conflicts/reviewStore.js';

const conflict = { rule: 5, type: 'status_conflict', chainId: 5, chainName: 'Goerli', message: 'Chain 5 (Goerli) has conflicting status' };

describe('conflict review store', () => {
  let dir;
  let file;
  let clock;
  const now = () => clock;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reviews-'));
    file = join(dir, 'conflict-reviews.json');
    clock = Date.parse('2026-09-28T00:00:00Z');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('has no decision for a conflict until one is made — open is the default', async () => {
    const store = createReviewStore({ file, now });
    expect(await store.get('abc')).toBeNull();
    expect(await store.all()).toEqual([]);
  });

  it('records a decision with who, when, why, and a snapshot of the conflict', async () => {
    const store = createReviewStore({ file, now });
    const d = await store.decide('abc', { state: STATES.DISMISSED, note: 'Goerli is gone', by: 'owner@x.io', conflict });
    expect(d).toMatchObject({
      id: 'abc', state: 'dismissed', note: 'Goerli is gone', by: 'owner@x.io',
      at: '2026-09-28T00:00:00.000Z', rule: 5, chainId: 5, chainName: 'Goerli'
    });
    expect(await store.get('abc')).toEqual(d);
  });

  it('replaces an earlier decision for the same conflict', async () => {
    const store = createReviewStore({ file, now });
    await store.decide('abc', { state: STATES.ACKNOWLEDGED, note: 'reported upstream', by: 'a@x.io', conflict });
    await store.decide('abc', { state: STATES.DISMISSED, note: 'upstream says intended', by: 'b@x.io', conflict });
    expect((await store.all())).toHaveLength(1);
    expect((await store.get('abc')).by).toBe('b@x.io');
  });

  it('refuses an unknown state', async () => {
    const store = createReviewStore({ file, now });
    await expect(store.decide('abc', { state: 'hidden', by: 'a@x.io', conflict })).rejects.toThrow(/Unknown state/);
  });

  it('clearing returns the conflict to open, and says what was removed', async () => {
    const store = createReviewStore({ file, now });
    await store.decide('abc', { state: STATES.DISMISSED, note: 'x', by: 'a@x.io', conflict });
    const removed = await store.clear('abc', { by: 'b@x.io' });
    expect(removed.state).toBe('dismissed');
    expect(await store.get('abc')).toBeNull();
    expect(await store.clear('abc', { by: 'b@x.io' })).toBeNull();
  });

  it('keeps an audit trail of every action, newest first — including reopen', async () => {
    const store = createReviewStore({ file, now });
    await store.decide('abc', { state: STATES.ACKNOWLEDGED, note: 'tracking', by: 'a@x.io', conflict });
    clock += 1000;
    await store.decide('abc', { state: STATES.DISMISSED, note: 'noise', by: 'a@x.io', conflict });
    clock += 1000;
    await store.clear('abc', { by: 'b@x.io', note: 'changed my mind' });
    const h = await store.history();
    expect(h.map((e) => e.action)).toEqual(['reopened', 'dismissed', 'acknowledged']);
    expect(h[0]).toMatchObject({ by: 'b@x.io', note: 'changed my mind', chainName: 'Goerli', id: 'abc' });
  });

  it('caps the history but never the decisions', async () => {
    const store = createReviewStore({ file, now });
    for (let i = 0; i < 2005; i++) await store.decide(`id${i}`, { state: STATES.DISMISSED, note: '', by: 'a@x.io', conflict });
    expect(await store.history(5000)).toHaveLength(2000);
    expect(await store.all()).toHaveLength(2005);
  }, 30000);

  it('survives a restart, writes owner-only, and keeps the final state under overlapping writes', async () => {
    const store = createReviewStore({ file, now });
    await Promise.all(['a', 'b', 'c'].map((id) => store.decide(id, { state: STATES.DISMISSED, note: id, by: 'a@x.io', conflict })));
    await store.flush();
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const restarted = createReviewStore({ file, now });
    expect((await restarted.all()).map((d) => d.id).sort()).toEqual(['a', 'b', 'c']);
    expect(await restarted.history()).toHaveLength(3);
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(1);
  });

  it('refuses to start on a corrupt file rather than silently forgetting every decision', async () => {
    await writeFile(file, '{ nope');
    const store = createReviewStore({ file, now });
    await expect(store.all()).rejects.toThrow(/refusing to start/);
  });

  it('ignores records with an unknown state when loading', async () => {
    await writeFile(file, JSON.stringify({ decisions: [{ id: 'x', state: 'weird' }, { id: 'y', state: 'dismissed' }] }));
    const store = createReviewStore({ file, now });
    expect((await store.all()).map((d) => d.id)).toEqual(['y']);
  });
});
