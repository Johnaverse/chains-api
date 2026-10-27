import { resolveIdentity, findIdentityConflicts } from '../../../src/domain/sourceIdentity.js';
import { kindWordsOf } from '../../../src/domain/networkWords.js';

const chains = (chainId, name, symbol) => ({ chainId, name, nativeCurrency: symbol ? { symbol } : undefined });
// Structural words are learned from how many unrelated ecosystems name their chains with them.
const KIND = kindWordsOf(['alder', 'birch', 'cedar', 'dogwood', 'elm', 'fir', 'ginkgo', 'hazel', 'ilex', 'juniper']
  .flatMap((eco) => ['Mainnet', 'Testnet', 'Devnet', 'Network', 'Chain'].map((k) => ({ name: `${eco} ${k}` }))));
const graph = (chainId, fullName, nativeToken, extra = {}) => ({ id: fullName.toLowerCase().replace(/\s+/g, '-'), caip2Id: `eip155:${chainId}`, fullName, nativeToken, ...extra });

describe('sourceIdentity', () => {
  it('builds a chain ID shared by two networks from the sources that agree, and names the one left out', () => {
    // Real case: 999 is Wanchain Testnet in chains.json and HyperEVM in chainlist and The Graph.
    const out = resolveIdentity({
      chains: chains(999, 'Wanchain Testnet', 'WAN'),
      chainlist: chains(999, 'HyperEVM', 'HYPE'),
      theGraph: graph(999, 'HyperEVM Mainnet', 'HYPE')
    });
    expect(out.kept).toEqual(['theGraph', 'chainlist']);
    expect(out.excluded).toEqual(['chains']);
    expect(out.identities).toEqual({
      chains: { name: 'Wanchain Testnet', symbol: 'WAN' },
      theGraph: { name: 'HyperEVM Mainnet', symbol: 'HYPE' },
      chainlist: { name: 'HyperEVM', symbol: 'HYPE' }
    });
  });

  it('keeps the registry of record on a one-to-one disagreement', () => {
    // Real case: 222 is "Permission" in chains.json and "OPN Chain Mainnet" in chainlist.
    const out = resolveIdentity({ chains: chains(222, 'Permission', 'ASK'), chainlist: chains(222, 'OPN Chain Mainnet', 'IOPN') });
    expect(out).toMatchObject({ kept: ['chains'], excluded: ['chainlist'] });
  });

  it('does not call a rename, a shared symbol or a bare entry a different network', () => {
    // HSKChain / Hashkey Chain: no shared word, same symbol.
    expect(resolveIdentity({ chains: chains(177, 'HSKChain', 'HSK'), theGraph: graph(177, 'Hashkey Chain Mainnet', 'HSK') })).toBeNull();
    // A shared word, different symbols (a token rename).
    expect(resolveIdentity({ chains: chains(88, 'Viction', 'VIC'), chainlist: chains(88, 'Viction Mainnet', 'TOMO') })).toBeNull();
    // Too little to compare: no symbol on one side, or only structural words.
    expect(resolveIdentity({ chains: chains(5, 'Alpha', 'A'), chainlist: chains(5, 'Beta') })).toBeNull();
    expect(resolveIdentity({ chains: chains(6, 'Devnet', 'X'), chainlist: chains(6, 'Testnet Network', 'Y') }, KIND)).toBeNull();
  });

  it('finds conflicts across the raw payloads, by EVM chain ID', () => {
    const conflicts = findIdentityConflicts({
      chains: [chains(1, 'Ethereum Mainnet', 'ETH'), chains(222, 'Permission', 'ASK')],
      chainlist: [chains(1, 'Ethereum', 'ETH'), chains(222, 'OPN Chain Mainnet', 'IOPN')],
      theGraph: { networks: [graph(1, 'Ethereum Mainnet', 'ETH'), { id: 'solana', caip2Id: 'solana:5eyk', fullName: 'Solana' }] }
    });
    expect([...conflicts.keys()]).toEqual([222]);
  });

  it('still reads a network named only by a common word that is a network\'s own id', () => {
    // "sepolia" follows ten ecosystems' names, so it is learned as structural — but The Graph
    // knows a network whose whole id it is, so a source naming the chain just "Sepolia" is not bare.
    const eco = ['alder', 'birch', 'cedar', 'dogwood', 'elm', 'fir', 'ginkgo', 'hazel', 'ilex', 'juniper'];
    const registry = eco.flatMap((e, i) => [chains(9000 + i, `${e} Mainnet`, 'X'), chains(9100 + i, `${e} Sepolia Testnet`, 'X')]);
    const theGraph = { networks: [
      { ...graph(11155111, 'Ethereum Sepolia Testnet', 'ETH'), id: 'sepolia' },
      graph(77, 'Unrelated Mainnet', 'OTHER'),
      graph(78, 'Zora Sepolia Testnet', 'ZORA')
    ] };
    const conflicts = findIdentityConflicts({
      chains: [...registry, chains(11155111, 'Sepolia', 'ETH'), chains(77, 'Sepolia', 'ETH'), chains(78, 'Sepolia', 'ETH')],
      // The same network spelled in full, with a different symbol: no conflict.
      chainlist: [chains(11155111, 'Ethereum Sepolia', 'sepETH')],
      theGraph
    });
    // Another ecosystem's Sepolia is not The Graph's "sepolia".
    expect([...conflicts.keys()]).toEqual([77, 78]);
    // A name made only of structural words no network goes by is still too bare to compare.
    expect(resolveIdentity({ chains: chains(6, 'Devnet', 'X'), chainlist: chains(6, 'Testnet Network', 'Y') }, KIND, new Map([['sepolia', new Set(['sepolia', 'ethereum'])]]))).toBeNull();
  });

  it('learns the structural words from chainlist when chains.json is missing', () => {
    const eco = ['alder', 'birch', 'cedar', 'dogwood', 'elm', 'fir', 'ginkgo', 'hazel', 'ilex', 'juniper'];
    const chainlist = [...eco.map((e, i) => chains(9000 + i, `${e} Mainnet`, 'X')), chains(77, 'Alpha Mainnet', 'AAA')];
    const theGraph = { networks: [graph(77, 'Beta Mainnet', 'BBB')] };
    // Sharing only "mainnet" does not make Alpha and Beta one network.
    expect([...findIdentityConflicts({ chains: [], chainlist, theGraph }).keys()]).toEqual([77]);
  });
});
