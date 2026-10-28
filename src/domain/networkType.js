/**
 * Mainnet or test network, from what each source says — and which source said it.
 *
 * Every source has an opinion, of different worth. The Graph states a `networkType` and
 * `testnetOf` relations; chains.json and chainlist can name a test-network parent. Those are
 * statements about exactly this. A name that says "Testnet" or "Mainnet" is the project's own
 * word. slip44 = 1 (the shared coin type for test networks) and chainlist's `isTestnet` are
 * hints: dozens of mainnets — World Chain, Plume, Morph — carry slip44 = 1, and chainlist sets
 * `isTestnet` from the name, false for Moonbase Alpha.
 *
 * The strongest claim decides. Hints that disagree at equal strength are weighed by how often
 * each has agreed with a stated type across the registry (learnHintReliability): measured on
 * 2026-10-28, chainlist's `isTestnet` agreed on 124 of 128 chains The Graph types, slip44 = 1 on
 * 27 of 29 — so a mainnet chainlist calls a mainnet (Morph, MANTRA, Superseed) is no longer
 * tagged Testnet for carrying slip44 = 1. Without enough evidence to tell them apart, a
 * test-network claim wins, as before. Every claim is kept so validation (rule 2) can show a
 * disagreement with each source's word on it.
 */

export const CLAIM_STRENGTH = { stated: 3, name: 2, hint: 1 };

const TEST_NAME = /\b(?:testnet|devnet)\b/i;
const MAIN_NAME = /\bmainnet\b/i;

function nameClaim(source, name) {
  if (typeof name !== 'string') return null;
  if (TEST_NAME.test(name)) return { source, field: 'name', value: 'testnet', strength: CLAIM_STRENGTH.name, said: name };
  if (MAIN_NAME.test(name)) return { source, field: 'name', value: 'mainnet', strength: CLAIM_STRENGTH.name, said: name };
  return null;
}

/**
 * Every claim the sources make about one chain.
 * @param {{chains?:object, chainlist?:object, theGraph?:object}} entries each source's raw entry
 */
// Hostnames of a chain's RPC, explorer and faucet URLs, split into words.
function hostWords(entries) {
  const urls = [];
  for (const entry of entries) {
    if (!entry) continue;
    for (const r of entry.rpc ?? []) urls.push(typeof r === 'string' ? r : r?.url);
    for (const e of entry.explorers ?? []) urls.push(e?.url);
    for (const f of entry.faucets ?? []) urls.push(f);
  }
  const words = new Set();
  for (const url of urls) {
    if (typeof url !== 'string' || url.includes('${')) continue;
    let host = '';
    try { host = new URL(url).hostname; } catch { continue; }
    for (const w of host.toLowerCase().split(/[^a-z0-9]+/)) if (w) words.add(w);
  }
  return words;
}

/**
 * Every claim the sources make about one chain.
 * @param {{chains?:object, chainlist?:object, theGraph?:object}} entries each source's raw entry
 * @param {{isTestWord?:(w:string)=>boolean, typeOf?:(chainId:number)=>('mainnet'|'testnet'|null)}} [learned]
 *   the registry's learned test-network words (networkWords.js), and the types already decided
 *   for other chains — a chain's parent among them
 */
// What the last index learned (setNetworkTypeContext), so validation reads a chain's claims as the
// indexer did.
let context = { isTestWord: null, typeOf: null };

/** The registry's test words and decided types, for every later networkTypeClaims call. */
export function setNetworkTypeContext({ isTestWord = null, typeOf = null } = {}) {
  context = { isTestWord, typeOf };
}

export function networkTypeClaims({ chains, chainlist, theGraph } = {}, { isTestWord = context.isTestWord, typeOf = context.typeOf } = {}) {
  const claims = [];
  const stated = (source, field, value, said) => claims.push({ source, field, value, strength: CLAIM_STRENGTH.stated, said });

  if (theGraph?.networkType === 'testnet' || theGraph?.networkType === 'mainnet') {
    stated('theGraph', 'networkType', theGraph.networkType, theGraph.networkType);
  }
  const graphTestnetOf = (theGraph?.relations ?? []).find((r) => r?.kind === 'testnetOf');
  if (graphTestnetOf) stated('theGraph', 'relations', 'testnet', `testnetOf ${graphTestnetOf.network}`);
  for (const [source, entry] of [['chains', chains], ['chainlist', chainlist]]) {
    if (entry?.parent?.type === 'testnet') stated(source, 'parent.type', 'testnet', `testnet of ${entry.parent.chain}`);
  }
  // A chain built on another (an L2's parent) is of its parent's kind: an L2 of Ethereum mainnet
  // is a mainnet (Morph, Reddio carry slip44 = 1), one of Sepolia a test network. A hint, weighed
  // like the others: upstream parents are wrong often enough (chains.json files Morph Holesky
  // under Ethereum mainnet, Cybria Mainnet under OP Sepolia) that a name must outrank it.
  // chains.json's word, chainlist's only where chains.json has no parent.
  const parentEntry = chains?.parent ? ['chains', chains] : chainlist?.parent ? ['chainlist', chainlist] : null;
  if (parentEntry && typeOf && parentEntry[1].parent.type !== 'testnet') {
    const m = /^eip155-(\d+)$/.exec(String(parentEntry[1].parent.chain ?? ''));
    const parentType = m ? typeOf(Number(m[1])) : null;
    if (parentType) claims.push({ source: parentEntry[0], field: 'parent', value: parentType, strength: CLAIM_STRENGTH.hint, said: `${parentEntry[1].parent.type ?? 'child'} of ${parentEntry[1].parent.chain}` });
  }

  for (const [source, name] of [['chains', chains?.name], ['chainlist', chainlist?.name], ['theGraph', theGraph?.fullName]]) {
    const claim = nameClaim(source, name);
    if (claim) claims.push(claim);
  }

  // chainlist copies chains.json's slip44 (720 of 720 agreed): one claim, not two votes. Its own
  // only when chains.json has none or a different one.
  if (chains?.slip44 === 1) claims.push({ source: 'chains', field: 'slip44', value: 'testnet', strength: CLAIM_STRENGTH.hint, said: 1 });
  else if (chainlist?.slip44 === 1) claims.push({ source: 'chainlist', field: 'slip44', value: 'testnet', strength: CLAIM_STRENGTH.hint, said: 1 });
  if (typeof chainlist?.isTestnet === 'boolean') {
    claims.push({ source: 'chainlist', field: 'isTestnet', value: chainlist.isTestnet ? 'testnet' : 'mainnet', strength: CLAIM_STRENGTH.hint, said: chainlist.isTestnet });
  }
  // The project's own hostnames: `testnet-rpc.atleta.network`, `pre-rpc.bt.io` beside
  // `testnet.bttcscan.com`, `mainnet.superseed.xyz`. Test words are the registry's learned ones.
  if (isTestWord) {
    const words = hostWords([chains, chainlist]);
    const test = [...words].find((w) => isTestWord(w));
    if (test) claims.push({ source: 'endpoints', field: 'hosts', value: 'testnet', strength: CLAIM_STRENGTH.hint, said: test });
    else if ([...words].some((w) => MAIN_NAME.test(w))) claims.push({ source: 'endpoints', field: 'hosts', value: 'mainnet', strength: CLAIM_STRENGTH.hint, said: 'mainnet' });
  }
  return claims;
}

// A hint's agreement with stated types needs this many chains to count; below it, a tie goes to
// the test-network claim as before.
const MIN_HINT_SAMPLE = 10;

// `${source}.${field}=${value}` -> { agree, total, accuracy }, from the last learnHintReliability.
let hintReliability = new Map();
// The prior log-odds of a test network, from the chains whose type is stated: what hints that
// cancel out leave the decision to.
let priorLogOdds = 0;

// Per claimed value: "isTestnet: false" and "isTestnet: true" are right at different rates.
const hintKey = (c) => `${c.source}.${c.field}=${c.value}`;

/**
 * How often each hint has agreed with a stated type (The Graph's networkType or a testnetOf /
 * parent relation) on the chains that have both. From the registry as indexed, so it follows the
 * sources as they change. `claimsByChain`: every chain's claims.
 */
export function learnHintReliability(claimsByChain) {
  const tally = new Map();
  const base = { testnet: 0, total: 0 };
  for (const claims of claimsByChain) {
    const stated = claims.filter((c) => c.strength === CLAIM_STRENGTH.stated);
    if (!stated.length || new Set(stated.map((c) => c.value)).size > 1) continue;
    const truth = stated[0].value;
    base.total += 1;
    if (truth === 'testnet') base.testnet += 1;
    for (const c of claims) {
      if (c.strength !== CLAIM_STRENGTH.hint) continue;
      const t = tally.get(hintKey(c)) ?? { agree: 0, total: 0 };
      t.total += 1;
      if (c.value === truth) t.agree += 1;
      tally.set(hintKey(c), t);
    }
  }
  hintReliability = new Map([...tally].map(([k, t]) => [k, { ...t, accuracy: t.agree / t.total }]));
  priorLogOdds = base.total >= MIN_HINT_SAMPLE && base.testnet > 0 && base.testnet < base.total
    ? Math.log(base.testnet / (base.total - base.testnet)) : 0;
  return hintReliability;
}

/** What was learned, for validation's evidence and /validate. */
export function getHintReliability() {
  return hintReliability;
}

function reliabilityOf(claim) {
  const r = hintReliability.get(hintKey(claim));
  return r && r.total >= MIN_HINT_SAMPLE ? r.accuracy : null;
}

// A hint's weight: the log-odds of its learned accuracy, so independent hints add up (two 93%
// hints outweigh one 97%). Clamped, so no hint is certain or worthless.
const weightOf = (accuracy) => {
  const p = Math.min(0.99, Math.max(0.51, accuracy));
  return Math.log(p / (1 - p));
};

/** The decision: `{ isTestnet, decidedBy }`, decidedBy null when no source said anything. */
export function resolveNetworkType(claims) {
  const top = Math.max(...claims.map((c) => c.strength), 0);
  const strongest = claims.filter((c) => c.strength === top);
  if (!strongest.length) return { isTestnet: false, decidedBy: null };
  const values = new Set(strongest.map((c) => c.value));
  if (values.size === 1) return { isTestnet: strongest[0].value === 'testnet', decidedBy: strongest[0] };
  // Disagreeing hints vote, each by how often it has been right where the type is stated. Without
  // that evidence for every one of them, a test-network claim wins, as before.
  if (top === CLAIM_STRENGTH.hint && strongest.every((c) => reliabilityOf(c) != null)) {
    // The base rate first: two hints of equal accuracy that disagree leave the prior.
    const score = { testnet: Math.max(priorLogOdds, 0), mainnet: Math.max(-priorLogOdds, 0) };
    for (const c of strongest) score[c.value] += weightOf(reliabilityOf(c));
    if (score.testnet !== score.mainnet) {
      const value = score.testnet > score.mainnet ? 'testnet' : 'mainnet';
      const decidedBy = strongest.filter((c) => c.value === value).sort((a, b) => reliabilityOf(b) - reliabilityOf(a))[0];
      return { isTestnet: value === 'testnet', decidedBy };
    }
  }
  const decidedBy = strongest.find((c) => c.value === 'testnet');
  return { isTestnet: true, decidedBy };
}

/** Whether the sources disagree at all. */
export function claimsDisagree(claims) {
  return new Set(claims.map((c) => c.value)).size > 1;
}
