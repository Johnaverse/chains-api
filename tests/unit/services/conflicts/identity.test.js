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

// Every conflict type, both ways: a change to what DEFINES the disagreement must mint a new id,
// while a change to presentation (display name, message wording) must not.
describe('conflictId — every type', () => {
  const cases = [
    ['relation_tag_conflict', 1, { graphRelation: { kind: 'l2Of', chainId: 1 } }, (e) => { e.graphRelation = { kind: 'l2Of', chainId: 10 }; }],
    ['relation_source_conflict', 1, { graphRelation: { kind: 'testnetOf', chainId: 1 }, chainlistData: { isTestnet: false } }, (e) => { e.chainlistData = { isTestnet: true }; }],
    ['slip44_testnet_mismatch', 2, { isTestnet: true, tags: ['Testnet'] }, (e) => { e.tags = ['Testnet', 'L2']; }],
    ['name_testnet_mismatch', 3, { fullName: 'Foo Testnet', tags: [] }, (e) => { e.fullName = 'Foo Devnet'; }],
    ['sepolia_hoodie_no_l2_or_relations', 4, { fullName: 'Sepolia', tags: [], relations: [] }, (e) => { e.fullName = 'Hoodi'; }],
    ['status_conflict', 5, { statuses: [{ source: 'chainlist', status: 'active' }] }, (e) => { e.statuses = [{ source: 'chainlist', status: 'deprecated' }]; }],
    ['goerli_not_deprecated', 6, { status: 'active', statusInSources: [] }, (e) => { e.status = 'incubating'; }],
    ['l2beat_missing_classification', 7, { l2BeatSlug: 'x', l2BeatStage: null, l2BeatCategory: null }, (e) => { e.l2BeatCategory = 'Optimium'; }],
    ['l2beat_hostchain_no_relation', 8, { l2BeatHostChainId: 1, existingRelationTargets: [] }, (e) => { e.l2BeatHostChainId = 10; }],
    ['l2beat_category_name_mismatch', 9, { fullName: 'Foo Rollup' }, (e) => { e.fullName = 'Foo Chain'; }],
    ['l2beat_unknown_chain', 10, { l2BeatSlug: 'foo' }, (e) => { e.l2BeatSlug = 'bar'; }],
    ['l2beat_stage_zero_high_tvs', 11, { l2BeatStage: 'Stage 0', l2BeatTvs: 1 }, (e) => { e.l2BeatStage = 'Stage 1'; }],
    ['rpc_block_height_drift', 12, { laggingEndpoint: { url: 'a', blockHeight: 1 } }, (e) => { e.laggingEndpoint = { url: 'b', blockHeight: 1 }; }],
    ['name_disagreement', 13, { chainsName: 'A', theGraphName: 'B' }, (e) => { e.theGraphName = 'C'; }],
    ['native_currency_mismatch', 14, { chainsSymbol: 'A', theGraphSymbol: 'B' }, (e) => { e.chainsSymbol = 'C'; }],
    ['slip44_native_symbol_mismatch', 15, { slip44Symbol: 'A', nativeSymbol: 'B', slip44CoinType: 1 }, (e) => { e.slip44CoinType = 2; }],
    ['active_child_of_deprecated_parent', 17, { parentChainId: 1, relationKind: 'l2Of' }, (e) => { e.parentChainId = 5; }]
  ];

  it.each(cases)('%s: identity fields change the id; presentation does not', (type, rule, fields, mutate) => {
    const base = { rule, type, chainId: 100, chainName: 'Some Chain', message: 'first wording', ...structuredClone(fields) };
    const cosmetic = { ...structuredClone(base), chainName: 'Renamed Chain', message: 'second wording' };
    expect(conflictId(cosmetic)).toBe(conflictId(base));

    const changed = structuredClone(base);
    mutate(changed);
    expect(conflictId(changed)).not.toBe(conflictId(base));
  });

  it('rpc_url_in_one_source_only has no evidence identity — only the chain decides', () => {
    const a = { rule: 16, type: 'rpc_url_in_one_source_only', chainId: 1, onlyInChainlistHealthy: ['x'] };
    expect(conflictId({ ...a, chainId: 2 })).not.toBe(conflictId(a));
  });
});
