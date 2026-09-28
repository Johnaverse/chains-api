import { createHash } from 'node:crypto';

/**
 * A stable identity for each cross-source conflict, so an admin's decision about it survives
 * re-validation, restarts and refreshes.
 *
 * The identity is built from WHAT DISAGREES, never from the whole record, because some
 * records carry values that move on their own:
 *
 *   rule 12 (RPC block-height drift) reports live block heights and the drift between them —
 *     even inside its message. Hashing the record would mint a new id every block, and an
 *     admin's "known lagging archive node" decision would vanish within seconds.
 *   rule 11 (Stage 0 with high value) carries TVS, which moves with the market.
 *   rule 16 (RPC URL in one source only) lists currently-HEALTHY URLs, which flap as
 *     endpoints go up and down; the finding worth deciding on is "these sources are out of
 *     sync for this chain", not today's health snapshot.
 *
 * The reverse matters just as much: when the disagreement itself changes, the identity MUST
 * change. Dismissing "chainlist says deprecated, chains says active" is a decision about that
 * pair of values; if a source later changes its value, that is a different disagreement and
 * it comes back as open rather than staying silently hidden under the old decision.
 */

const sorted = (xs) => (Array.isArray(xs) ? [...xs].map(String).sort() : []);
const pairs = (xs, a, b) => (Array.isArray(xs) ? xs.map((x) => `${x?.[a]}=${x?.[b]}`).sort() : []);

// Per conflict type: the fields that define the disagreement. Anything absent here is
// deliberately NOT part of the identity.
const IDENTITY = {
  relation_tag_conflict: (e) => [e.graphRelation?.kind, e.graphRelation?.chainId],
  relation_source_conflict: (e) => [e.graphRelation?.kind, e.graphRelation?.chainId, e.chainlistData?.isTestnet],
  slip44_testnet_mismatch: (e) => [e.isTestnet ?? null, sorted(e.tags)],
  name_testnet_mismatch: (e) => [e.fullName, sorted(e.tags)],
  sepolia_hoodie_no_l2_or_relations: (e) => [e.fullName],
  status_conflict: (e) => pairs(e.statuses, 'source', 'status'),
  goerli_not_deprecated: (e) => [e.status, pairs(e.statusInSources, 'source', 'status')],
  l2beat_missing_classification: (e) => [e.l2BeatSlug, e.l2BeatStage, e.l2BeatCategory],
  l2beat_hostchain_no_relation: (e) => [e.l2BeatHostChainId],
  l2beat_category_name_mismatch: (e) => [e.fullName],
  l2beat_unknown_chain: (e) => [e.l2BeatSlug],
  l2beat_stage_zero_high_tvs: (e) => [e.l2BeatStage], // TVS moves with the market
  rpc_block_height_drift: (e) => [e.laggingEndpoint?.url], // heights move every block
  name_disagreement: (e) => [e.chainsName, e.theGraphName],
  native_currency_mismatch: (e) => [e.chainsSymbol, e.theGraphSymbol],
  slip44_native_symbol_mismatch: (e) => [e.slip44Symbol, e.nativeSymbol, e.slip44CoinType],
  rpc_url_in_one_source_only: () => [], // health flaps; the finding is "sources out of sync"
  active_child_of_deprecated_parent: (e) => [e.parentChainId, e.relationKind]
};

/**
 * @param {object} conflict one record from validateChainData()
 * @returns {string} 20-hex-character id
 */
export function conflictId(conflict) {
  const identity = IDENTITY[conflict?.type];
  // A rule added later without an entry here falls back to rule + type + chain: coarse, but it
  // can never churn. Churn is the worse failure — it silently discards decisions.
  const parts = [conflict?.rule ?? null, conflict?.type ?? null, conflict?.chainId ?? null, ...(identity ? identity(conflict) : [])];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 20);
}

/** Whether a type has an explicit identity — for tests that guard against a silent fallback. */
export function hasExplicitIdentity(type) {
  return Object.hasOwn(IDENTITY, type);
}

// The same wording the dashboard uses (public/app.js RULE_LABELS), so an admin reading the
// review queue and a visitor reading the tile see one vocabulary.
export const RULE_LABELS = Object.freeze({
  1: 'Conflicting relations between sources',
  2: 'SLIP-44 coin type on a testnet',
  3: 'Name says testnet but the tag disagrees',
  4: 'Sepolia / Hoodi naming problems',
  5: 'Lifecycle status conflicts',
  6: 'Goerli chains not marked deprecated',
  7: 'L2BEAT project missing a classification',
  8: 'L2BEAT host chain with no relation',
  9: 'L2BEAT category disagrees with the name',
  10: 'L2BEAT project not in the registry',
  11: 'Stage 0 rollup holding high value',
  12: 'RPC endpoints disagree on block height',
  13: 'Sources disagree on the network name',
  14: 'Native currency mismatch',
  15: 'SLIP-44 symbol vs native symbol mismatch',
  16: 'RPC URL present in only one source',
  17: 'Active chain under a deprecated parent'
});

const IDENTITY_FIELDS = new Set(['rule', 'type', 'chainId', 'chainName', 'message', 'severity']);

/** The rule-specific fields of a conflict — what the admin needs to see to decide. */
export function evidenceOf(conflict) {
  const out = {};
  for (const [k, v] of Object.entries(conflict ?? {})) if (!IDENTITY_FIELDS.has(k)) out[k] = v;
  return out;
}
