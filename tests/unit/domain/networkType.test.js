import { networkTypeClaims, resolveNetworkType, claimsDisagree, learnHintReliability } from '../../../src/domain/networkType.js';

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

describe('hints weighed by how often they agree with stated types', () => {
  // Chains The Graph types outright, each with slip44 and chainlist's isTestnet: chainlist is
  // right on every one, slip44 = 1 on a mainnet for 3 of 12.
  const typed = (type, slip44, isTestnet) => networkTypeClaims({
    chains: { name: 'X', slip44 }, chainlist: { name: 'X', slip44, isTestnet }, theGraph: { networkType: type }
  });
  const corpus = [
    ...Array.from({ length: 9 }, () => typed('testnet', 1, true)),
    ...Array.from({ length: 3 }, () => typed('mainnet', 1, false)),
    ...Array.from({ length: 8 }, () => typed('mainnet', 60, false))
  ];

  it('counts chainlist\'s copy of chains.json\'s slip44 once', () => {
    const claims = networkTypeClaims({ chains: { name: 'Morph', slip44: 1 }, chainlist: { name: 'Morph', slip44: 1, isTestnet: false } });
    expect(claims.filter((c) => c.field === 'slip44').map((c) => c.source)).toEqual(['chains']);
  });

  it('lets the hints vote by their learned accuracy: Morph, slip44 = 1 but chainlist mainnet', () => {
    const reliability = learnHintReliability(corpus);
    // Learned per claimed value.
    expect(reliability.get('chainlist.isTestnet=mainnet')).toMatchObject({ agree: 11, total: 11 });
    expect(reliability.get('chainlist.isTestnet=testnet')).toMatchObject({ agree: 9, total: 9 });
    expect(reliability.get('chains.slip44=testnet')).toMatchObject({ agree: 9, total: 12 });
    const morph = networkTypeClaims({ chains: { name: 'Morph', slip44: 1 }, chainlist: { name: 'Morph', slip44: 1, isTestnet: false } });
    expect(resolveNetworkType(morph)).toMatchObject({ isTestnet: false, decidedBy: { source: 'chainlist', field: 'isTestnet' } });
    // A name still outranks both hints.
    expect(resolveNetworkType(networkTypeClaims({ chains: { name: 'Morph Testnet', slip44: 1 }, chainlist: { isTestnet: false } })).isTestnet).toBe(true);
  });

  it('reads the parent\'s type and the project\'s hostnames', () => {
    const typeOf = (id) => (id === 1 ? 'mainnet' : id === 11155111 ? 'testnet' : null);
    const isTestWord = (w) => w === 'testnet';
    // Stated mainnets that are L2s of Ethereum mainnet: the parent hint is learned reliable.
    const l2s = Array.from({ length: 12 }, () => networkTypeClaims({ chains: { name: 'L2', parent: { type: 'L2', chain: 'eip155-1' } }, theGraph: { networkType: 'mainnet' } }, { typeOf, isTestWord }));
    learnHintReliability([...corpus, ...l2s]);
    // An L2 of Ethereum mainnet is a mainnet, whatever its slip44.
    const morph = networkTypeClaims({ chains: { name: 'Morph', slip44: 1, parent: { type: 'L2', chain: 'eip155-1' } } }, { typeOf, isTestWord });
    expect(resolveNetworkType(morph)).toMatchObject({ isTestnet: false, decidedBy: { field: 'parent' } });
    // A test word in its own endpoints' hosts is a test-network hint.
    const donau = networkTypeClaims({ chains: { name: 'BitTorrent Chain Donau', slip44: 1, rpc: ['https://pre-rpc.bt.io/'], explorers: [{ url: 'https://testnet.bttcscan.com' }] }, chainlist: { isTestnet: false } }, { typeOf, isTestWord });
    expect(donau.find((c) => c.field === 'hosts')).toMatchObject({ value: 'testnet', said: 'testnet' });
  });

  it('falls back to the test-network claim without enough evidence', () => {
    learnHintReliability(corpus.slice(0, 5));
    const tie = networkTypeClaims({ chains: { name: 'Y', slip44: 1 }, chainlist: { name: 'Y', isTestnet: false } });
    expect(resolveNetworkType(tie).isTestnet).toBe(true);
    learnHintReliability([]);
  });
});

