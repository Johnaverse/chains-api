import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { conflictId, hasExplicitIdentity, evidenceOf, RULE_LABELS } from '../../../../src/services/conflicts/identity.js';

const drift = (overrides = {}) => ({
  rule: 12, chainId: 1, chainName: 'Ethereum', type: 'rpc_block_height_drift',
  message: 'Chain 1 (Ethereum) has working RPC endpoints reporting block heights 40 blocks apart',
  drift: 40, threshold: 10,
  laggingEndpoint: { url: 'https://slow.example', blockHeight: 100 },
  leadingEndpoint: { url: 'https://fast.example', blockHeight: 140 },
  ...overrides
});

describe('conflictId — values that move on their own must not churn the id', () => {
  it('rule 12: new block heights and a new drift (even in the message) keep the same id', () => {
    const later = drift({
      drift: 57,
      message: 'Chain 1 (Ethereum) has working RPC endpoints reporting block heights 57 blocks apart',
      laggingEndpoint: { url: 'https://slow.example', blockHeight: 900 },
      leadingEndpoint: { url: 'https://fast.example', blockHeight: 957 }
    });
    expect(conflictId(later)).toBe(conflictId(drift()));
  });

  it('rule 11: TVS moving with the market keeps the same id', () => {
    const base = { rule: 11, chainId: 42161, type: 'l2beat_stage_zero_high_tvs', l2BeatStage: 'Stage 0', l2BeatTvs: 1e9 };
    expect(conflictId({ ...base, l2BeatTvs: 3.7e9 })).toBe(conflictId(base));
  });

  it('rule 16: healthy-URL lists flapping keep the same id', () => {
    const base = { rule: 16, chainId: 10, type: 'rpc_url_in_one_source_only', onlyInChainlistHealthy: ['a'], onlyInChainsHealthy: [] };
    expect(conflictId({ ...base, onlyInChainlistHealthy: ['a', 'b'], onlyInChainsHealthy: ['c'] })).toBe(conflictId(base));
  });
});

describe('conflictId — a changed disagreement must get a new id', () => {
  it('rule 12: a different endpoint lagging is a different finding', () => {
    expect(conflictId(drift({ laggingEndpoint: { url: 'https://other.example', blockHeight: 100 } }))).not.toBe(conflictId(drift()));
  });

  it('rule 5: a source changing its status reopens the conflict', () => {
    const before = { rule: 5, chainId: 5, type: 'status_conflict', statuses: [{ source: 'chainlist', status: 'deprecated' }, { source: 'chains', status: 'active' }] };
    const after = { ...before, statuses: [{ source: 'chainlist', status: 'deprecated' }, { source: 'chains', status: 'incubating' }] };
    expect(conflictId(after)).not.toBe(conflictId(before));
  });

  it('rule 5: the ORDER sources are listed in does not matter', () => {
    const a = { rule: 5, chainId: 5, type: 'status_conflict', statuses: [{ source: 'chainlist', status: 'deprecated' }, { source: 'chains', status: 'active' }] };
    const b = { ...a, statuses: [...a.statuses].reverse() };
    expect(conflictId(b)).toBe(conflictId(a));
  });

  it('distinguishes chains, and two relation findings on one chain', () => {
    const rel = (chainId, kind) => ({ rule: 1, chainId, type: 'relation_tag_conflict', graphRelation: { kind, chainId: 1 } });
    expect(conflictId(rel(10, 'l2Of'))).not.toBe(conflictId(rel(11, 'l2Of')));
    expect(conflictId(rel(10, 'l2Of'))).not.toBe(conflictId(rel(10, 'testnetOf')));
  });

  it('rule 14: a symbol change reopens', () => {
    const a = { rule: 14, chainId: 56, type: 'native_currency_mismatch', chainsSymbol: 'BNB', theGraphSymbol: 'ETH' };
    expect(conflictId({ ...a, theGraphSymbol: 'WBNB' })).not.toBe(conflictId(a));
  });
});

describe('conflictId — robustness', () => {
  it('is a 20-hex id', () => {
    expect(conflictId(drift())).toMatch(/^[0-9a-f]{20}$/);
  });

  it('falls back to rule + type + chain for an unknown type, without throwing', () => {
    const a = { rule: 99, chainId: 7, type: 'future_rule', volatile: Math.random() };
    const b = { ...a, volatile: Math.random() };
    expect(conflictId(a)).toBe(conflictId(b));
  });

  it('tolerates missing fields', () => {
    expect(() => conflictId({})).not.toThrow();
    expect(() => conflictId(undefined)).not.toThrow();
  });
});

describe('every validation rule has an explicit identity', () => {
  it('matches the conflict types validation.js actually emits', () => {
    // Read the source rather than a hand-kept list: a rule added without an identity must fail
    // here, not quietly fall back to the coarse default.
    const src = readFileSync(new URL('../../../../src/services/validation.js', import.meta.url), 'utf8');
    const types = [...new Set([...src.matchAll(/type:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]))];
    expect(types.length).toBeGreaterThanOrEqual(17);
    const missing = types.filter((t) => !hasExplicitIdentity(t));
    expect(missing).toEqual([]);
  });

  it('labels all 17 rules', () => {
    for (let r = 1; r <= 17; r++) expect(RULE_LABELS[r]).toMatch(/\w/);
  });
});

describe('evidenceOf', () => {
  it('keeps the rule-specific fields and drops the identity ones', () => {
    const ev = evidenceOf(drift());
    expect(ev).toHaveProperty('laggingEndpoint');
    expect(ev).toHaveProperty('drift');
    for (const k of ['rule', 'type', 'chainId', 'chainName', 'message']) expect(ev).not.toHaveProperty(k);
  });

  it('handles nothing', () => {
    expect(evidenceOf(null)).toEqual({});
  });
});
