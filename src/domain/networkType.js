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
 * The strongest claim decides; at equal strength a test-network claim wins, as the indexer's
 * tag-on-any-hint rule always had it. Every claim is kept so validation (rule 2) can show a
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
export function networkTypeClaims({ chains, chainlist, theGraph } = {}) {
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

  for (const [source, name] of [['chains', chains?.name], ['chainlist', chainlist?.name], ['theGraph', theGraph?.fullName]]) {
    const claim = nameClaim(source, name);
    if (claim) claims.push(claim);
  }

  for (const [source, entry] of [['chains', chains], ['chainlist', chainlist]]) {
    if (entry?.slip44 === 1) claims.push({ source, field: 'slip44', value: 'testnet', strength: CLAIM_STRENGTH.hint, said: 1 });
  }
  if (typeof chainlist?.isTestnet === 'boolean') {
    claims.push({ source: 'chainlist', field: 'isTestnet', value: chainlist.isTestnet ? 'testnet' : 'mainnet', strength: CLAIM_STRENGTH.hint, said: chainlist.isTestnet });
  }
  return claims;
}

/** The decision: `{ isTestnet, decidedBy }`, decidedBy null when no source said anything. */
export function resolveNetworkType(claims) {
  let best = null;
  for (const c of claims) {
    if (!best || c.strength > best.strength || (c.strength === best.strength && c.value === 'testnet' && best.value !== 'testnet')) best = c;
  }
  return { isTestnet: best?.value === 'testnet', decidedBy: best };
}

/** Whether the sources disagree at all. */
export function claimsDisagree(claims) {
  return new Set(claims.map((c) => c.value)).size > 1;
}
