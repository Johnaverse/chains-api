import { describe, it, expect, beforeEach } from 'vitest';
import { learnNetworkWords, isTestNetworkWord, mentionsTestNetwork, isNetworkName, chainOfBareName, kindWordsOf, isKindWord } from '../../../src/domain/networkWords.js';
import { KIND_REGISTRY } from '../../fixtures/structuralWords.js';
import { TESTNET_REGISTRY } from '../../fixtures/testnetRegistry.js';

const test = (chainId, name, extra = {}) => ({ chainId, name, tags: ['Testnet'], ...extra });

describe('test-network words, learned from the registry', () => {
  beforeEach(() => learnNetworkWords([...TESTNET_REGISTRY]));

  it('reads the words that qualify test networks, and no ecosystem name', () => {
    for (const w of ['sepolia', 'hoodi', 'holesky', 'chapel', 'amoy', 'fuji', 'testnet']) expect(isTestNetworkWord(w)).toBe(true);
    for (const w of ['ethereum', 'base', 'bnb', 'avalanche', 'mainnet']) expect(isTestNetworkWord(w)).toBe(false);
    expect(mentionsTestNetwork('Base Sepolia')).toBe(true);
    expect(mentionsTestNetwork('BNB Smart Chain')).toBe(false);
  });

  it('calls a name a network only on several test networks', () => {
    expect(isNetworkName('Hoodi')).toBe(true);
    expect(isNetworkName('Sepolia testnet')).toBe(true);
    // One testnet qualifies Chapel: enough to read "BSC Chapel" as a testnet, not to call a fork named so a network.
    expect(isNetworkName('Chapel')).toBe(false);
  });

  it('is not misled by a project whose chains are mostly testnets, or a testnet named like a fork', () => {
    learnNetworkWords([
      ...TESTNET_REGISTRY,
      { chainId: 314, name: 'Filecoin - Mainnet', tags: [] },
      test(314159, 'Filecoin - Calibration testnet'), test(3141, 'Filecoin - Hyperspace testnet'), test(31415926, 'Filecoin Local testnet'),
      test(9999, 'Foo Istanbul'), test(9998, 'Bar Istanbul'), test(9997, 'Baz Network v1')
    ]);
    expect(isTestNetworkWord('filecoin')).toBe(false);
    // One chain's name is not evidence: "calibration" names a single testnet here.
    expect(isTestNetworkWord('calibration')).toBe(false);
    expect(isTestNetworkWord('v1')).toBe(false);
    // Two testnets named "Istanbul" read a mention as a testnet, but never make the fork a network.
    expect(isNetworkName('Istanbul')).toBe(false);
  });

  it('finds the chain a bare network name is the registry id of', () => {
    expect(chainOfBareName('hoodi')?.chainId).toBe(560048);
    expect(chainOfBareName('chapel')?.chainId).toBe(97);
    expect(chainOfBareName('nowhere')).toBeNull();
  });
});

describe('kind words, learned from the registry', () => {
  it('learns a word many unrelated ecosystems put after their own name', () => {
    const kind = kindWordsOf(KIND_REGISTRY);
    expect([...kind].sort()).toEqual(['blockchain', 'chain', 'evm', 'mainnet', 'network', 'protocol']);
  });

  it('does not learn a project word that repeats inside one ecosystem, or a leading one', () => {
    const skale = Array.from({ length: 16 }, (_, i) => ({ chainId: 7000 + i, name: `Skale Hub ${i}` }));
    const leading = ['alder', 'birch', 'cedar', 'dogwood', 'elm', 'fir', 'ginkgo', 'hazel', 'ilex', 'juniper']
      .map((eco, i) => ({ chainId: 8000 + i, name: `Zeta ${eco}` }));
    const kind = kindWordsOf([...KIND_REGISTRY, ...skale, ...leading]);
    expect(kind.has('hub')).toBe(false);
    expect(kind.has('zeta')).toBe(false);
    expect(kind.has('mainnet')).toBe(true);
  });

  it('serves what learnNetworkWords last learned', () => {
    learnNetworkWords([...TESTNET_REGISTRY, ...KIND_REGISTRY]);
    expect(isKindWord('Chain')).toBe(true);
    expect(isKindWord('ethereum')).toBe(false);
  });
});
