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
// "Testnet"), are learned from chains.json's names (kindWordsOf) and passed in as `kind`.
function nameWords(kind, ...names) {
  const words = new Set();
  for (const name of names) {
    for (const w of String(name ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
      if (w && !kind.has(w) && !/^\d+$/.test(w)) words.add(w);
    }
  }
  return words;
}

/** What one source says a chain ID is: its names, as words, and its native symbol. */
export function identityOf(source, entry, kind = new Set()) {
  if (!entry) return null;
  if (source === 'theGraph') {
    return {
      name: entry.fullName ?? entry.shortName ?? entry.id ?? null,
      symbol: entry.nativeToken ?? null,
      words: nameWords(kind, entry.fullName, entry.shortName, entry.id, ...(Array.isArray(entry.aliases) ? entry.aliases : []))
    };
  }
  return {
    name: entry.name ?? null,
    symbol: entry.nativeCurrency?.symbol ?? null,
    words: nameWords(kind, entry.name, entry.shortName, entry.chain)
  };
}

function sameNetwork(a, b) {
  if (!a.words.size || !b.words.size || !a.symbol || !b.symbol) return true;
  for (const w of a.words) if (b.words.has(w)) return true;
  return a.symbol.toUpperCase() === b.symbol.toUpperCase();
}

/**
 * The sources to build one chain ID's record from, given each source's entry for it.
 * `kind`: the registry's structural words (kindWordsOf), which say nothing about which network.
 * Returns null when every pair agrees (the usual case); otherwise `{ kept, excluded, identities }`.
 */
export function resolveIdentity(entries, kind = new Set()) {
  const present = SOURCE_PRECEDENCE.filter((s) => entries[s]);
  if (present.length < 2) return null;
  const ids = Object.fromEntries(present.map((s) => [s, identityOf(s, entries[s], kind)]));
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
  const conflicts = new Map();
  for (const id of new Set([...bySource.chains.keys(), ...bySource.chainlist.keys(), ...bySource.theGraph.keys()])) {
    const resolved = resolveIdentity({
      chains: bySource.chains.get(id),
      chainlist: bySource.chainlist.get(id),
      theGraph: bySource.theGraph.get(id)
    }, kind);
    if (resolved) conflicts.set(id, resolved);
  }
  return conflicts;
}

