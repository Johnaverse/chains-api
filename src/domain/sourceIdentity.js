import { kindWordsOf } from './networkWords.js';

/**
 * Whether the registries mean the same network by one chain ID.
 *
 * Chain IDs are not unique in practice: chains.json, chainlist and The Graph each list one entry
 * per ID, and for a dozen IDs they list different networks — 999 is Wanchain Testnet in
 * chains.json and HyperEVM in the other two; 222 is "Permission" in one and "OPN Chain" in
 * another. Merging those by ID produced records that were half one network and half the other
 * (one's name, the other's RPCs and type), which no source ever said.
 *
 * So identity is checked before anything merges. Two entries name different networks only on
 * positive evidence: both names have distinctive words and share none, AND both state a native
 * symbol and the symbols differ. A rename ("HSKChain" / "Hashkey Chain") keeps its symbol, and an
 * entry too bare to say ("Devnet", no symbol) is not a conflict. Where entries disagree, the record is built from the sources that agree with
 * each other — the larger group, or on a tie the group holding the source listed first in
 * SOURCE_PRECEDENCE — and the rest are left out of the record and reported (validation rule 20)
 * with what each source said, for a person to settle upstream.
 */

// chains.json is the EIP-155 registry of record; The Graph is curated; chainlist is the
// broadest and the most often reused for a different network.
export const SOURCE_PRECEDENCE = ['chains', 'theGraph', 'chainlist'];

// Words that say what kind of network a name is, not which network ("Mainnet", "Chain",
// "Testnet"), are learned from chains.json's names (kindWordsOf) and passed in as `kind`. A name
// made only of them says nothing ("Devnet") — unless one of its words is a network's whole id in
// The Graph's registry (`bare`, id -> that network's own name words): "Sepolia" is common across
// ecosystems, yet The Graph's "sepolia" is "Ethereum Sepolia Testnet", so it reads as `ethereum`
// and agrees with "Ethereum Sepolia" while "Zora Sepolia" or "Unrelated Mainnet" still conflict.
const wordsOf = (...names) => names.flatMap((name) => String(name ?? '').toLowerCase().split(/[^a-z0-9]+/))
  .filter((w) => w && !/^\d+$/.test(w));

function nameWords(kind, bare, ...names) {
  const all = wordsOf(...names);
  const words = new Set(all.filter((w) => !kind.has(w)));
  return words.size ? words : new Set(all.flatMap((w) => [...(bare.get(w) ?? [])]));
}

/** The Graph's networks whose whole id is one word, each with its own distinctive name words. */
function bareNetworkWords(networks, kind) {
  const bare = new Map();
  for (const n of Array.isArray(networks) ? networks : []) {
    const id = String(n?.id ?? '').toLowerCase();
    if (!/^[a-z]+$/.test(id)) continue;
    const own = wordsOf(n.fullName, n.shortName, ...(Array.isArray(n.aliases) ? n.aliases : [])).filter((w) => !kind.has(w));
    bare.set(id, new Set([id, ...own]));
  }
  return bare;
}

/** What one source says a chain ID is: its names, as words, and its native symbol. */
export function identityOf(source, entry, kind = new Set(), bare = new Map()) {
  if (!entry) return null;
  if (source === 'theGraph') {
    return {
      name: entry.fullName ?? entry.shortName ?? entry.id ?? null,
      symbol: entry.nativeToken ?? null,
      words: nameWords(kind, bare, entry.fullName, entry.shortName, entry.id, ...(Array.isArray(entry.aliases) ? entry.aliases : []))
    };
  }
  return {
    name: entry.name ?? null,
    symbol: entry.nativeCurrency?.symbol ?? null,
    words: nameWords(kind, bare, entry.name, entry.shortName, entry.chain)
  };
}

function sameNetwork(a, b) {
  if (!a.words.size || !b.words.size || !a.symbol || !b.symbol) return true;
  for (const w of a.words) if (b.words.has(w)) return true;
  return a.symbol.toUpperCase() === b.symbol.toUpperCase();
}

/**
 * The sources to build one chain ID's record from, given each source's entry for it.
 * `kind`: the registry's structural words (kindWordsOf), which say nothing about which network;
 * `bare`: The Graph's one-word network ids ("sepolia"), each with that network's own name words.
 * Returns null when every pair agrees (the usual case); otherwise `{ kept, excluded, identities }`.
 */
export function resolveIdentity(entries, kind = new Set(), bare = new Map()) {
  const present = SOURCE_PRECEDENCE.filter((s) => entries[s]);
  if (present.length < 2) return null;
  const ids = Object.fromEntries(present.map((s) => [s, identityOf(s, entries[s], kind, bare)]));
  const agree = (a, b) => sameNetwork(ids[a], ids[b]);
  if (present.every((a, i) => present.slice(i + 1).every((b) => agree(a, b)))) return null;

  // Largest group of mutually agreeing sources; ties go to the group with the earliest source,
  // which subsets in precedence order find first.
  let kept = [present[0]];
  for (let mask = 1; mask < 1 << present.length; mask++) {
    const group = present.filter((_, i) => mask & (1 << i));
    if (group.length <= kept.length) continue;
    if (group.every((a, i) => group.slice(i + 1).every((b) => agree(a, b)))) kept = group;
  }
  return {
    kept,
    excluded: present.filter((s) => !kept.includes(s)),
    identities: Object.fromEntries(present.map((s) => [s, { name: ids[s].name, symbol: ids[s].symbol }]))
  };
}

/** The EVM chain ID in a networks-registry entry's CAIP-2 id, else null. */
export const graphChainId = (n) => {
  const m = typeof n?.caip2Id === 'string' ? /^eip155:(\d+)$/.exec(n.caip2Id) : null;
  return m ? Number.parseInt(m[1], 10) : null;
};

/**
 * Every chain ID whose sources disagree on the network, from the raw source payloads.
 * @returns {Map<number, {kept:string[], excluded:string[], identities:object}>}
 */
export function findIdentityConflicts({ theGraph, chainlist, chains }) {
  const bySource = { chains: new Map(), chainlist: new Map(), theGraph: new Map() };
  const add = (source, id, entry) => {
    if (Number.isFinite(id) && !bySource[source].has(id)) bySource[source].set(id, entry);
  };
  for (const c of Array.isArray(chains) ? chains : []) add('chains', Number(c?.chainId), c);
  for (const c of Array.isArray(chainlist) ? chainlist : []) add('chainlist', Number(c?.chainId), c);
  for (const n of Array.isArray(theGraph?.networks) ? theGraph.networks : []) add('theGraph', graphChainId(n), n);

  // From chains.json, else chainlist's names: a chains.json outage must not leave "Mainnet" as
  // the word that makes two networks one.
  const kind = kindWordsOf(Array.isArray(chains) && chains.length ? chains : Array.isArray(chainlist) ? chainlist : []);
  const bare = bareNetworkWords(theGraph?.networks, kind);
  const conflicts = new Map();
  for (const id of new Set([...bySource.chains.keys(), ...bySource.chainlist.keys(), ...bySource.theGraph.keys()])) {
    const resolved = resolveIdentity({
      chains: bySource.chains.get(id),
      chainlist: bySource.chainlist.get(id),
      theGraph: bySource.theGraph.get(id)
    }, kind, bare);
    if (resolved) conflicts.set(id, resolved);
  }
  return conflicts;
}

