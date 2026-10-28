import { describe, it, expect, beforeEach } from 'vitest';
import { applyDataToCache, cachedData } from '../../../src/store/cache.js';
import { validateChainData } from '../../../src/services/validation.js';
import { indexData } from '../../../src/store/indexer.js';

/**
 * validateChainData() short-circuits to an error when any of the 3 upstream
 * sources are absent. To exercise the L2BEAT rules in isolation we have to
 * seed all of theGraph + chainlist + chains, even if they don't matter for
 * the specific rule under test.
 */
function seedCache({
  chains,
  l2beatProjects = null,
  rawChains = [],
  rawChainlist = [],
  rpcHealth = {}
}) {
  const byChainId = {};
  for (const c of chains) byChainId[c.chainId] = c;

  applyDataToCache({
    theGraph: { networks: [] },
    chainlist: rawChainlist,
    chains: rawChains,
    slip44: {},
    l2beat: l2beatProjects
      ? { source: 'live', fetchedAt: '2026-05-05T00:00:00.000Z', projects: l2beatProjects }
      : null,
    indexed: {
      byChainId,
      byName: {},
      all: chains
    },
    rpcHealth,
    lastUpdated: '2026-05-05T00:00:00.000Z'
  });
  cachedData.indexed.all = Object.values(cachedData.indexed.byChainId);
}

function findErrorsForRule(report, ruleNumber) {
  return report.allErrors.filter(e => e.rule === ruleNumber);
}

describe('validation — L2BEAT cross-source rules', () => {
  beforeEach(() => {
    applyDataToCache({});
  });

  describe('rule 7: l2beat_missing_classification', () => {
    it('flags chains classified by L2BEAT but with no l2Of/testnetOf relation from other sources', () => {
      seedCache({
        chains: [{
          chainId: 42161,
          name: 'Arbitrum One',
          tags: ['L2'],
          relations: [],
          l2Beat: { slug: 'arbitrum', stage: 'Stage 1', category: 'Optimistic Rollup' }
        }]
      });
      const report = validateChainData();
      const errs = findErrorsForRule(report, 7);
      expect(errs).toHaveLength(1);
      expect(errs[0].l2BeatSlug).toBe('arbitrum');
    });

    it('does NOT flag chains with a corroborating l2Of relation from theGraph or chains', () => {
      seedCache({
        chains: [{
          chainId: 42161,
          name: 'Arbitrum One',
          tags: ['L2'],
          relations: [{ kind: 'l2Of', chainId: 1, source: 'theGraph' }],
          l2Beat: { slug: 'arbitrum', stage: 'Stage 1', category: 'Optimistic Rollup' }
        }]
      });
      expect(findErrorsForRule(validateChainData(), 7)).toHaveLength(0);
    });

    it('does NOT flag chains without any L2BEAT data', () => {
      seedCache({
        chains: [{ chainId: 1, name: 'Ethereum', tags: [], relations: [] }]
      });
      expect(findErrorsForRule(validateChainData(), 7)).toHaveLength(0);
    });
  });

  describe('rule 8: l2beat_hostchain_no_relation', () => {
    it('flags chains where L2BEAT hostChainId has no matching l2Of/testnetOf relation', () => {
      seedCache({
        chains: [{
          chainId: 42161,
          name: 'Arbitrum One',
          tags: ['L2'],
          relations: [{ kind: 'l2Of', chainId: 999, source: 'theGraph' }],
          l2Beat: { slug: 'arbitrum', hostChainId: 1 }
        }]
      });
      const errs = findErrorsForRule(validateChainData(), 8);
      expect(errs).toHaveLength(1);
      expect(errs[0].l2BeatHostChainId).toBe(1);
    });

    it('does NOT flag chains where a relation points to hostChainId', () => {
      seedCache({
        chains: [{
          chainId: 42161,
          name: 'Arbitrum One',
          tags: ['L2'],
          relations: [{ kind: 'l2Of', chainId: 1, source: 'theGraph' }],
          l2Beat: { slug: 'arbitrum', hostChainId: 1 }
        }]
      });
      expect(findErrorsForRule(validateChainData(), 8)).toHaveLength(0);
    });
  });

  describe('rule 9: l2beat_category_name_mismatch', () => {
    it('flags ZK category with optimistic-sounding name', () => {
      seedCache({
        chains: [{
          chainId: 999,
          name: 'Optimistic Rollup Project',
          tags: ['L2'],
          relations: [{ kind: 'l2Of', chainId: 1, source: 'theGraph' }],
          l2Beat: {
            slug: 'something',
            displayName: 'Optimistic Rollup Project',
            category: 'ZK Rollup',
            hostChainId: 1
          }
        }]
      });
      const errs = findErrorsForRule(validateChainData(), 9);
      expect(errs).toHaveLength(1);
      expect(errs[0].l2BeatCategory).toBe('ZK Rollup');
    });

    it('does NOT flag matching category/name', () => {
      seedCache({
        chains: [{
          chainId: 324,
          name: 'ZKsync Era',
          tags: ['L2'],
          relations: [{ kind: 'l2Of', chainId: 1, source: 'theGraph' }],
          l2Beat: {
            slug: 'zksync-era',
            displayName: 'ZKsync Era',
            category: 'ZK Rollup',
            hostChainId: 1
          }
        }]
      });
      expect(findErrorsForRule(validateChainData(), 9)).toHaveLength(0);
    });
  });

  describe('rule 10: l2beat_unknown_chains', () => {
    it('flags L2BEAT projects whose chainId is not in our registry', () => {
      seedCache({
        chains: [{
          chainId: 42161,
          name: 'Arbitrum One',
          tags: ['L2'],
          relations: [{ kind: 'l2Of', chainId: 1, source: 'theGraph' }],
          l2Beat: { slug: 'arbitrum', hostChainId: 1 }
        }],
        l2beatProjects: [
          { slug: 'arbitrum', chainId: 42161, displayName: 'Arbitrum One' },
          { slug: 'brand-new-l2', chainId: 999888, displayName: 'Brand New L2', stage: 'Stage 0' }
        ]
      });
      const errs = findErrorsForRule(validateChainData(), 10);
      expect(errs).toHaveLength(1);
      expect(errs[0].chainId).toBe(999888);
      expect(errs[0].l2BeatSlug).toBe('brand-new-l2');
    });

    it('emits nothing when every L2BEAT project maps to a known chainId', () => {
      seedCache({
        chains: [{
          chainId: 42161,
          name: 'Arbitrum One',
          tags: ['L2'],
          relations: [{ kind: 'l2Of', chainId: 1, source: 'theGraph' }],
          l2Beat: { slug: 'arbitrum', hostChainId: 1 }
        }],
        l2beatProjects: [{ slug: 'arbitrum', chainId: 42161, displayName: 'Arbitrum One' }]
      });
      expect(findErrorsForRule(validateChainData(), 10)).toHaveLength(0);
    });

    it('emits nothing when l2beat cache is unavailable', () => {
      seedCache({
        chains: [{ chainId: 1, name: 'Ethereum', tags: [], relations: [] }],
        l2beatProjects: null
      });
      expect(findErrorsForRule(validateChainData(), 10)).toHaveLength(0);
    });
  });

  describe('rule 11: l2beat_stage_zero_high_tvs', () => {
    it('flags Stage 0 chains with TVS > $1B', () => {
      seedCache({
        chains: [{
          chainId: 81457,
          name: 'Blast',
          tags: ['L2'],
          relations: [{ kind: 'l2Of', chainId: 1, source: 'theGraph' }],
          l2Beat: { slug: 'blast', stage: 'Stage 0', tvs: 2_500_000_000, hostChainId: 1 }
        }]
      });
      const errs = findErrorsForRule(validateChainData(), 11);
      expect(errs).toHaveLength(1);
      expect(errs[0].l2BeatTvs).toBe(2_500_000_000);
    });

    it('does NOT flag Stage 1+ chains regardless of TVS', () => {
      seedCache({
        chains: [{
          chainId: 42161,
          name: 'Arbitrum One',
          tags: ['L2'],
          relations: [{ kind: 'l2Of', chainId: 1, source: 'theGraph' }],
          l2Beat: { slug: 'arbitrum', stage: 'Stage 1', tvs: 10_000_000_000, hostChainId: 1 }
        }]
      });
      expect(findErrorsForRule(validateChainData(), 11)).toHaveLength(0);
    });

    it('does NOT flag Stage 0 chains below the threshold', () => {
      seedCache({
        chains: [{
          chainId: 999,
          name: 'Small L2',
          tags: ['L2'],
          relations: [{ kind: 'l2Of', chainId: 1, source: 'theGraph' }],
          l2Beat: { slug: 'small', stage: 'Stage 0', tvs: 100_000_000, hostChainId: 1 }
        }]
      });
      expect(findErrorsForRule(validateChainData(), 11)).toHaveLength(0);
    });
  });

  describe('rule 15 and severity', () => {
    const chain = (chainId, name, symbol, coinType, slip44Symbol) => ({ chainId, name, tags: [], relations: [], nativeCurrency: { symbol }, slip44Info: { coinType, symbol: slip44Symbol } });

    it('flags only a coin type of the chain\'s own, not one several chains share', () => {
      seedCache({
        chains: [
          // Ethereum's 60, borrowed by EVM chains with their own currency: a convention.
          chain(1, 'Ethereum', 'ETH', 60, 'ETH'), chain(8, 'c8ntinuum', 'CTM', 60, 'ETH'), chain(9, 'Other', 'OTH', 60, 'ETH'),
          // A coin type only Viction uses, still registered under its old symbol: a real mismatch.
          chain(88, 'Viction', 'VIC', 889, 'TOMO')
        ]
      });
      expect(findErrorsForRule(validateChainData(), 15).map(e => e.chainId)).toEqual([88]);
    });

    it('keeps flagging a coin type\'s owner whatever other chains use it', () => {
      // An unrelated chain on 889 with another currency does not make Viction's TOMO a convention.
      seedCache({ chains: [chain(88, 'Viction', 'VIC', 889, 'TOMO'), chain(99, 'Unrelated', 'XYZ', 889, 'TOMO')] });
      expect(findErrorsForRule(validateChainData(), 15).map(e => e.chainId).sort()).toEqual([88, 99]);
    });

    it('counts errors and notices apart', () => {
      seedCache({
        chains: [chain(88, 'Viction', 'VIC', 889, 'TOMO')],
        rpcHealth: {}
      });
      const report = validateChainData();
      expect(report.bySeverity.error).toBe(report.allErrors.filter(e => e.severity === 'error').length);
      expect(report.allErrors.every(e => e.severity === 'error' || e.severity === 'notice')).toBe(true);
      expect(findErrorsForRule(report, 15)[0].severity).toBe('error');
    });
  });

  describe('rule 21: rpc_serves_another_chain', () => {
    it('reports an endpoint listed for a chain that serves another, and nothing else', () => {
      seedCache({
        chains: [
          { chainId: 42429, name: 'Tempo Testnet Andantino (Deprecated)', tags: ['Testnet'], relations: [], status: 'deprecated', rpc: ['https://rpc.testnet.tempo.xyz'] },
          { chainId: 42431, name: 'Tempo Testnet Moderato', tags: ['Testnet'], relations: [] }
        ],
        rpcHealth: {
          42429: [{ url: 'https://rpc.testnet.tempo.xyz', ok: false, failure: 'wrong_chain', servedChainId: 42431, blockHeight: 16 }],
          42431: [{ url: 'https://rpc.testnet.tempo.xyz', ok: true, blockHeight: 16 }]
        }
      });
      const report = validateChainData();
      const errs = findErrorsForRule(report, 21);
      expect(errs).toHaveLength(1);
      expect(errs[0]).toMatchObject({ chainId: 42429, endpoints: [{ url: 'https://rpc.testnet.tempo.xyz', servedChainId: 42431, servedChainName: 'Tempo Testnet Moderato' }] });
      // Not "a deprecated chain still serves blocks": its endpoint is another chain's.
      expect(findErrorsForRule(report, 19)).toHaveLength(0);
      expect(report.summary.rule21).toBe(1);
    });

    it('forgets an endpoint the chain no longer lists', () => {
      seedCache({
        chains: [{ chainId: 42429, name: 'Andantino', tags: ['Testnet'], relations: [], rpc: [] }],
        rpcHealth: { 42429: [{ url: 'https://rpc.testnet.tempo.xyz', ok: false, failure: 'wrong_chain', servedChainId: 42431 }] }
      });
      expect(findErrorsForRule(validateChainData(), 21)).toHaveLength(0);
    });
  });

  describe('rule 12: rpc_block_height_drift', () => {
    it('flags when working RPCs disagree by more than 100 blocks', () => {
      seedCache({
        chains: [{ chainId: 1, name: 'Ethereum', tags: [], relations: [] }],
        rpcHealth: {
          1: [
            { url: 'https://rpc-a', ok: true, blockHeight: 1_000_000 },
            { url: 'https://rpc-b', ok: true, blockHeight: 1_000_500 },
            { url: 'https://rpc-c', ok: false, error: 'timeout' }
          ]
        }
      });
      const errs = findErrorsForRule(validateChainData(), 12);
      expect(errs).toHaveLength(1);
      expect(errs[0].drift).toBe(500);
      expect(errs[0].laggingEndpoint.url).toBe('https://rpc-a');
      expect(errs[0].leadingEndpoint.url).toBe('https://rpc-b');
    });

    it('does NOT flag when RPCs agree within the threshold', () => {
      seedCache({
        chains: [{ chainId: 1, name: 'Ethereum', tags: [], relations: [] }],
        rpcHealth: {
          1: [
            { url: 'https://rpc-a', ok: true, blockHeight: 1_000_000 },
            { url: 'https://rpc-b', ok: true, blockHeight: 1_000_010 }
          ]
        }
      });
      expect(findErrorsForRule(validateChainData(), 12)).toHaveLength(0);
    });

    it('does NOT flag chains with fewer than 2 working endpoints', () => {
      seedCache({
        chains: [{ chainId: 1, name: 'Ethereum', tags: [], relations: [] }],
        rpcHealth: {
          1: [{ url: 'https://rpc-a', ok: true, blockHeight: 1_000_000 }]
        }
      });
      expect(findErrorsForRule(validateChainData(), 12)).toHaveLength(0);
    });
  });

  describe('rule 13: name_disagreement', () => {
    it('flags meaningfully different names from chains.json vs theGraph', () => {
      seedCache({
        chains: [{
          chainId: 137,
          name: 'Polygon',
          tags: [],
          relations: [],
          sources: ['chains', 'theGraph'],
          theGraph: { fullName: 'Matic Network' }
        }]
      });
      const errs = findErrorsForRule(validateChainData(), 13);
      expect(errs).toHaveLength(1);
      expect(errs[0].chainsName).toBe('Polygon');
      expect(errs[0].theGraphName).toBe('Matic Network');
    });

    it('does NOT flag substring variations like "Arbitrum One" vs "Arbitrum"', () => {
      seedCache({
        chains: [{
          chainId: 42161,
          name: 'Arbitrum One',
          tags: [],
          relations: [],
          sources: ['chains', 'theGraph'],
          theGraph: { fullName: 'Arbitrum' }
        }]
      });
      expect(findErrorsForRule(validateChainData(), 13)).toHaveLength(0);
    });

    it('ignores "Mainnet" suffix differences', () => {
      seedCache({
        chains: [{
          chainId: 1,
          name: 'Ethereum',
          tags: [],
          relations: [],
          sources: ['chains', 'theGraph'],
          theGraph: { fullName: 'Ethereum Mainnet' }
        }]
      });
      expect(findErrorsForRule(validateChainData(), 13)).toHaveLength(0);
    });
  });

  describe('rule 14: native_currency_mismatch', () => {
    it('flags when chains.json and theGraph disagree on native symbol', () => {
      seedCache({
        chains: [{
          chainId: 1,
          name: 'Ethereum',
          tags: [],
          relations: [],
          nativeCurrency: { symbol: 'ETH' },
          theGraph: { nativeToken: 'ETC' }
        }]
      });
      const errs = findErrorsForRule(validateChainData(), 14);
      expect(errs).toHaveLength(1);
      expect(errs[0].chainsSymbol).toBe('ETH');
      expect(errs[0].theGraphSymbol).toBe('ETC');
    });

    it('is case-insensitive', () => {
      seedCache({
        chains: [{
          chainId: 1,
          name: 'Ethereum',
          tags: [],
          relations: [],
          nativeCurrency: { symbol: 'eth' },
          theGraph: { nativeToken: 'ETH' }
        }]
      });
      expect(findErrorsForRule(validateChainData(), 14)).toHaveLength(0);
    });
  });

  describe('rule 15: slip44_native_symbol_mismatch', () => {
    it('flags when slip44 symbol disagrees with native currency symbol', () => {
      seedCache({
        chains: [{
          chainId: 1,
          name: 'Ethereum',
          tags: [],
          relations: [],
          nativeCurrency: { symbol: 'ETH' },
          slip44Info: { coinType: 60, symbol: 'BTC' }
        }]
      });
      const errs = findErrorsForRule(validateChainData(), 15);
      expect(errs).toHaveLength(1);
      expect(errs[0].slip44CoinType).toBe(60);
    });

    it('does NOT flag matching symbols', () => {
      seedCache({
        chains: [{
          chainId: 1,
          name: 'Ethereum',
          tags: [],
          relations: [],
          nativeCurrency: { symbol: 'ETH' },
          slip44Info: { coinType: 60, symbol: 'ETH' }
        }]
      });
      expect(findErrorsForRule(validateChainData(), 15)).toHaveLength(0);
    });
  });

  describe('rule 16: rpc_url_in_one_source_only', () => {
    it('flags healthy RPC URLs that exist in chainlist but not chains.json', () => {
      seedCache({
        chains: [{
          chainId: 1,
          name: 'Ethereum',
          tags: [],
          relations: [],
          sources: ['chains', 'chainlist']
        }],
        rawChains: [{ chainId: 1, rpc: ['https://rpc-old.example'] }],
        rawChainlist: [{ chainId: 1, rpc: ['https://rpc-old.example', 'https://rpc-new.example'] }],
        rpcHealth: {
          1: [
            { url: 'https://rpc-old.example', ok: true, blockHeight: 1000 },
            { url: 'https://rpc-new.example', ok: true, blockHeight: 1000 }
          ]
        }
      });
      const errs = findErrorsForRule(validateChainData(), 16);
      expect(errs).toHaveLength(1);
      expect(errs[0].onlyInChainlistHealthy).toContain('https://rpc-new.example');
      expect(errs[0].onlyInChainsHealthy).toEqual([]);
    });

    it('does NOT flag URLs that are unhealthy in both sources', () => {
      seedCache({
        chains: [{
          chainId: 1,
          name: 'Ethereum',
          tags: [],
          relations: [],
          sources: ['chains', 'chainlist']
        }],
        rawChains: [{ chainId: 1, rpc: ['https://rpc-a'] }],
        rawChainlist: [{ chainId: 1, rpc: ['https://rpc-a', 'https://rpc-b-broken'] }],
        rpcHealth: {
          1: [
            { url: 'https://rpc-a', ok: true, blockHeight: 1000 },
            { url: 'https://rpc-b-broken', ok: false, error: 'timeout' }
          ]
        }
      });
      expect(findErrorsForRule(validateChainData(), 16)).toHaveLength(0);
    });

    it('does NOT flag when chain is only in one source', () => {
      seedCache({
        chains: [{
          chainId: 1,
          name: 'Ethereum',
          tags: [],
          relations: [],
          sources: ['chains']
        }],
        rawChains: [{ chainId: 1, rpc: ['https://rpc-a'] }],
        rawChainlist: [],
        rpcHealth: { 1: [{ url: 'https://rpc-a', ok: true, blockHeight: 1000 }] }
      });
      expect(findErrorsForRule(validateChainData(), 16)).toHaveLength(0);
    });
  });

  describe('rule 17: active_child_of_deprecated_parent', () => {
    it('flags an active chain whose l2Of parent is deprecated (propagation regression guard)', () => {
      seedCache({
        chains: [
          { chainId: 5, name: 'Goerli', status: 'deprecated', tags: [], relations: [] },
          {
            chainId: 420, name: 'Optimism Goerli', status: 'active', tags: ['L2'],
            relations: [{ kind: 'l2Of', chainId: 5, source: 'chains' }]
          }
        ]
      });
      const errs = findErrorsForRule(validateChainData(), 17);
      expect(errs).toHaveLength(1);
      expect(errs[0]).toMatchObject({ chainId: 420, parentChainId: 5, relationKind: 'l2Of' });
    });

    it('does NOT flag when the child is already deprecated or the parent is alive', () => {
      seedCache({
        chains: [
          { chainId: 5, name: 'Goerli', status: 'deprecated', tags: [], relations: [] },
          {
            chainId: 420, name: 'Optimism Goerli', status: 'deprecated', tags: ['L2'],
            relations: [{ kind: 'l2Of', chainId: 5, source: 'chains' }]
          },
          {
            chainId: 10, name: 'OP Mainnet', status: 'active', tags: ['L2'],
            relations: [{ kind: 'l2Of', chainId: 1, source: 'chains' }]
          },
          { chainId: 1, name: 'Ethereum', status: 'active', tags: [], relations: [] }
        ]
      });
      expect(findErrorsForRule(validateChainData(), 17)).toHaveLength(0);
    });
  });

  describe('summary aggregation', () => {
    it('reports counts for all 11 rules in summary + errorsByRule', () => {
      seedCache({
        chains: [{
          chainId: 42161,
          name: 'Arbitrum One',
          tags: ['L2'],
          relations: [],
          l2Beat: { slug: 'arbitrum', stage: 'Stage 1', category: 'Optimistic Rollup', hostChainId: 1 }
        }]
      });
      const report = validateChainData();
      for (const n of [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]) {
        expect(report.summary).toHaveProperty(`rule${n}`);
      }
      expect(report.errorsByRule).toHaveProperty('rule7_l2beat_missing_classification');
      expect(report.errorsByRule).toHaveProperty('rule12_rpc_block_height_drift');
      expect(report.errorsByRule).toHaveProperty('rule13_name_disagreement');
      expect(report.errorsByRule).toHaveProperty('rule14_native_currency_mismatch');
      expect(report.errorsByRule).toHaveProperty('rule15_slip44_native_symbol_mismatch');
      expect(report.errorsByRule).toHaveProperty('rule16_rpc_url_in_one_source_only');
      expect(report.errorsByRule).toHaveProperty('rule17_active_child_of_deprecated_parent');
    });
  });

  describe('source traceability: rules 2 and 20 on the indexed record', () => {
    // Real shapes: 999 is Wanchain Testnet in chains.json and HyperEVM in the other two;
    // World Chain carries slip44 = 1 though The Graph states it is a mainnet.
    const theGraph = { networks: [
      { id: 'hyper-evm', caip2Id: 'eip155:999', fullName: 'HyperEVM Mainnet', nativeToken: 'HYPE', networkType: 'mainnet', rpcUrls: ['https://rpc.hyperliquid.example'] },
      { id: 'worldchain', caip2Id: 'eip155:480', fullName: 'World Chain Mainnet', nativeToken: 'ETH', networkType: 'mainnet' }
    ] };
    const chainlist = [
      { chainId: 999, name: 'HyperEVM', nativeCurrency: { symbol: 'HYPE' }, rpc: [{ url: 'https://rpc.hyperliquid.example' }] },
      { chainId: 480, name: 'World Chain', nativeCurrency: { symbol: 'ETH' }, slip44: 1, isTestnet: false }
    ];
    const chains = [
      { chainId: 999, name: 'Wanchain Testnet', nativeCurrency: { symbol: 'WAN' }, slip44: 1, rpc: ['https://gwan.wanchain.example'] },
      { chainId: 480, name: 'World Chain', nativeCurrency: { symbol: 'ETH' }, slip44: 1 }
    ];

    function load() {
      applyDataToCache({
        theGraph, chainlist, chains, slip44: {}, l2beat: null,
        indexed: indexData(theGraph, chainlist, chains, {}, null),
        rpcHealth: {}, lastUpdated: '2026-10-27T00:00:00.000Z'
      });
      return validateChainData();
    }

    it('keeps a source that names another network out of the record, and reports it with every source\'s word', () => {
      const report = load();
      const record = cachedData.indexed.byChainId[999];
      expect(record.name).toBe('HyperEVM');
      expect(record.sources).not.toContain('chains');
      expect(record.rpc).not.toContain('https://gwan.wanchain.example');
      expect(record.tags).not.toContain('Testnet');
      expect(findErrorsForRule(report, 20)).toEqual([expect.objectContaining({
        chainId: 999,
        type: 'chain_id_collision',
        kept: ['theGraph', 'chainlist'],
        excluded: ['chains'],
        identities: expect.objectContaining({ chains: { name: 'Wanchain Testnet', symbol: 'WAN' } })
      })]);
      // The left-out entry raises nothing else: its slip44 is not a claim about HyperEVM.
      expect(findErrorsForRule(report, 2).map(e => e.chainId)).not.toContain(999);
    });

    it('tags by the strongest claim and lists the ones it overruled', () => {
      const report = load();
      expect(cachedData.indexed.byChainId[480].tags).not.toContain('Testnet');
      const [worldChain] = findErrorsForRule(report, 2).filter(e => e.chainId === 480);
      expect(worldChain).toMatchObject({ resolved: 'mainnet', decidedBy: { source: 'theGraph', field: 'networkType' }, contested: false });
      // chainlist copies chains.json's slip44: one claim, not two.
      expect(worldChain.claims.filter(c => c.value === 'testnet').map(c => `${c.source}.${c.field}`).sort())
        .toEqual(['chains.slip44']);
      expect(report.summary).toHaveProperty('rule20', 1);
    });
  });
});
