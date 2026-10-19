/**
 * Which words name a test network, read from the chain registry rather than listed in code.
 *
 * A word is a test-network word when the chains it names — in a name, TheGraph id or alias —
 * are nearly all ones the registry tags `Testnet`, and there are several of them: Sepolia,
 * Hoodi and Amoy qualify; Ethereum and Polygon also name main networks and never do. New
 * testnets join as the registry lists them.
 */
let words = new Set();
let learnedFrom = null;
// TheGraph id / alias -> chain, for a network named bare ("hoodi" is Ethereum Hoodi's id).
let bareNames = new Map();

const tokens = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

function namesOf(chain) {
  return [chain?.name, chain?.['theGraph-id'], ...(Array.isArray(chain?.aliases) ? chain.aliases : [])]
    .filter((n) => typeof n === 'string' && n && !/^evm-\d+$/.test(n));
}

// Two strengths. A word that QUALIFIES test networks — follows the ecosystem, as in "Polygon
// Amoy", "bnb-chapel" — and names no main network reads a network mention as a test network.
// A word is a NETWORK NAME outright (a fork "named" Hoodi is the network, not a fork) only on
// more evidence: several test networks, most of them naming it as the qualifier, and nearly all
// chains carrying it tagged Testnet — registry tags have gaps, and a project whose chains are
// mostly testnets ("Filecoin", leading every name) must not count.
const MIN_TESTNETS = 3;
const MIN_TEST_SHARE = 0.8;

let strong = new Set();

/** Rebuild from the registry's chains. Cheap to call repeatedly: memoized on the array. */
export function learnNetworkWords(chains) {
  if (!Array.isArray(chains) || chains === learnedFrom) return;
  const testAny = new Map(); // word -> testnet chains naming it anywhere
  const testQual = new Map(); // word -> testnet chains naming it after the first word
  const all = new Map(); // word -> chains naming it
  const bare = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const chain of chains) {
    const isTest = Array.isArray(chain.tags) && chain.tags.includes('Testnet');
    const seen = new Set();
    const qual = new Set();
    for (const name of namesOf(chain)) {
      const ts = tokens(name);
      ts.forEach((t, i) => { seen.add(t); if (i > 0) qual.add(t); });
      if (ts.length === 1 && name !== chain.name) {
        if (!bare.has(ts[0])) bare.set(ts[0], []);
        bare.get(ts[0]).push(chain);
      }
    }
    for (const t of seen) {
      bump(all, t);
      if (isTest) bump(testAny, t);
      if (isTest && qual.has(t)) bump(testQual, t);
    }
  }
  const numeric = (t) => /^\d+$/.test(t);
  words = new Set([...testQual.keys()].filter((t) => !numeric(t) && testAny.get(t) === all.get(t)));
  strong = new Set([...testAny].filter(([t, n]) => !numeric(t) && n >= MIN_TESTNETS
    && n / all.get(t) >= MIN_TEST_SHARE && (testQual.get(t) ?? 0) * 2 >= n).map(([t]) => t));
  for (const t of strong) words.add(t);
  bareNames = bare;
  learnedFrom = chains;
}

/** Whether `text` is a network's name and nothing else ("Hoodi", "Sepolia testnet"). */
export function isNetworkName(text) {
  const ts = tokens(text);
  return ts.length > 0 && ts.every((t) => strong.has(t));
}

/** Whether this one word names a test network ("sepolia", "testnet"). */
export function isTestNetworkWord(word) {
  return words.has(String(word ?? '').toLowerCase());
}

/** Whether any word of `text` names a test network ("Base Sepolia", "bsc-chapel"). */
export function mentionsTestNetwork(text) {
  return tokens(text).some((t) => words.has(t));
}

/** The one chain whose registry id or alias is exactly this bare name, else null. */
export function chainOfBareName(name) {
  const hits = bareNames.get(String(name ?? '').toLowerCase()) ?? [];
  return hits.length === 1 ? hits[0] : null;
}

/** Every learned test-network word, sorted: what /repositories serves the client feed. */
export function testNetworkWords() {
  return [...words].sort();
}

export function _testNetworkWordsForTests() {
  return { words, strong };
}
