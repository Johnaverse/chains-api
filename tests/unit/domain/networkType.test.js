import { networkTypeClaims, resolveNetworkType, claimsDisagree } from '../../../src/domain/networkType.js';

const decide = (entries) => {
  const claims = networkTypeClaims(entries);
  const { isTestnet, decidedBy } = resolveNetworkType(claims);
  return { isTestnet, by: decidedBy && `${decidedBy.source}.${decidedBy.field}`, disagree: claimsDisagree(claims) };
};

describe('networkType', () => {
  it('lets a stated network type outrank a slip44 hint (World Chain)', () => {
    expect(decide({
      chains: { name: 'World Chain', slip44: 1 },
      chainlist: { name: 'World Chain', slip44: 1, isTestnet: false },
      theGraph: { fullName: 'World Chain Mainnet', networkType: 'mainnet' }
    })).toEqual({ isTestnet: false, by: 'theGraph.networkType', disagree: true });
  });

  it('lets the name outrank a hint when no source states a type (Plume Mainnet)', () => {
    expect(decide({ chains: { name: 'Plume Mainnet', slip44: 1 }, chainlist: { name: 'Plume Mainnet', isTestnet: false } }))
      .toEqual({ isTestnet: false, by: 'chains.name', disagree: true });
  });

  it('keeps the test-network default when only hints disagree', () => {
    expect(decide({ chains: { name: 'Morph', slip44: 1 }, chainlist: { name: 'Morph', isTestnet: false } }))
      .toEqual({ isTestnet: true, by: 'chains.slip44', disagree: true });
  });

  it('reads a testnet parent and a testnetOf relation as stated', () => {
    expect(decide({ chains: { name: 'Base Sepolia', parent: { type: 'testnet', chain: 'eip155-8453' } } }).by).toBe('chains.parent.type');
    expect(decide({ theGraph: { fullName: 'Moonbase Alpha', relations: [{ kind: 'testnetOf', network: 'moonbeam' }] } }))
      .toEqual({ isTestnet: true, by: 'theGraph.relations', disagree: false });
  });

  it('defaults to mainnet when no source says anything', () => {
    expect(decide({ chains: { name: 'Ethereum' } })).toEqual({ isTestnet: false, by: null, disagree: false });
  });
});
