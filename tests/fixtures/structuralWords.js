/**
 * Evidence for the words src/domain learns rather than lists: which words of a fork's name are
 * generic (forkWords.js, from feed titles and the names the classifier took from them) and which
 * words of a chain's name only say what kind of network it is (networkWords.js kindWordsOf, from
 * how many unrelated ecosystems use them). A test that needs "the Glamsterdam upgrade" to be
 * Glamsterdam, or "Ethereum Mainnet" to be named by "ethereum" alone, learns from these.
 */

// Titles as the feeds write them, each with the fork name the classifier read from it.
const titled = (title, name) => ({ title, url: `https://feed.example/${encodeURIComponent(title)}`, enrichment: { fork: { name } } });
export const FORK_TITLE_MENTIONS = [
  titled('Ethereum confirms the Glamsterdam upgrade date', 'Glamsterdam'),
  titled('[Standard] Morph - Hoodi Mainnet - Upgrade to v0.6.4 (Celadon Fork)', 'Celadon'),
  titled('Mandatory node release: Fusaka hard fork on mainnet', 'Fusaka'),
  titled('Gnosis Chain network upgrade: the Pectra hard fork', 'Pectra'),
  titled('Mandatory upgrade for the Jenner hard fork on testnet', 'Jenner'),
  titled('Network upgrade release for Lorentz on testnet', 'Lorentz'),
  titled('Testnet node release: Maxwell mandatory upgrade', 'Maxwell'),
  titled('Mainnet node upgrade for Fermi', 'Fermi')
];

// Ten unrelated ecosystems naming their chains with the registry's structural words.
const ECOSYSTEMS = ['alder', 'birch', 'cedar', 'dogwood', 'elm', 'fir', 'ginkgo', 'hazel', 'ilex', 'juniper'];
const KINDS = ['Mainnet', 'Chain', 'Network', 'EVM', 'Protocol', 'Blockchain'];
export const KIND_REGISTRY = ECOSYSTEMS.flatMap((eco, i) => KINDS.map((kind, j) => ({ chainId: 9_000_000 + i * 10 + j, name: `${eco} ${kind}` })));
