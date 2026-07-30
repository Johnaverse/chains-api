import { getChainById, searchChains } from '../store/queries.js';

/**
 * Attribute an RPC-provider incident to the chain it is about.
 *
 * Provider status pages are organised by provider, not by chain, so a provider
 * incident normally arrives with `chains: []` — of 18 ongoing provider incidents
 * observed live, exactly ONE carried a chain, and only because that provider's
 * status page exposes Atlassian components. Everything else was unattributable,
 * which means `getLiveIncidents({chainId})` returned nothing for a chain that
 * three separate providers were reporting an outage on.
 *
 * The chain name is in the title; the hard part is resolving it. That is already
 * solved by searchChains(), which handles the mainnet/testnet variant problem
 * ("Robinhood Testnet" → 46630 Robinhood Chain Testnet, not 4663 Robinhood
 * Chain). A hand-rolled matcher here got that exact case wrong on the first
 * attempt — "Scroll Sepolia … partial outage" resolved to Scroll MAINNET — so
 * this module only produces candidate QUERIES and delegates every decision
 * about which chain they mean.
 */

// How the chain on an incident was established, strongest first. Mirrors the
// evidence discipline in docs/SERVICE-CONTRACT.md rule 14: a derived value must
// say how it was derived, because a guessed chain and a declared one cannot be
// read the same way.
export const CHAIN_EVIDENCE = ['declared', 'title'];

// Leading noise on provider status-page titles: severity/urgency markers and
// bracketed labels the feed already strips for its own extraction.
const LEADING_NOISE = /^(?:\s*(?:\[[^\]]{0,40}\]|\*[^*]{0,40}\*|\((?:urgent|standard|critical)\))\s*|\s*(?:urgent|standard|critical|scheduled|update)\s*[-–—:]\s*)+/i;

// A candidate made only of these is not a chain name. Without this guard a title
// like "Node API Degraded" probes the registry for "node", which substring-matches
// a long tail of unrelated chains.
const NOT_A_CHAIN = new Set([
  'rpc', 'json', 'jsonrpc', 'api', 'apis', 'http', 'https', 'ws', 'wss', 'node', 'nodes',
  'network', 'networks', 'chain', 'chains', 'mainnet', 'testnet', 'devnet', 'archive',
  'degraded', 'degradation', 'outage', 'outages', 'down', 'downtime', 'incident',
  'performance', 'latency', 'elevated', 'partial', 'major', 'minor', 'global', 'regional',
  'maintenance', 'scheduled', 'upgrade', 'migrating', 'migration', 'delayed', 'issues',
  'service', 'services', 'disruption', 'errors', 'error', 'failures', 'and', 'for', 'the',
  'in', 'on', 'of', 'to', 'is', 'are', 'was', 'were', 'urgent', 'update', 'updates'
]);

// A candidate resolving to more of the registry than this is too generic to trust.
// The point is to reject a guess, not to rank one: "sepolia" alone matches dozens
// of chains and naming any single one of them would be a fabrication.
const MAX_AMBIGUITY = 8;

// Longest phrase worth probing. Status pages lead with the network, and beyond
// four words a leading phrase is prose rather than a name.
const MAX_PHRASE_WORDS = 4;

/**
 * Ordered candidate queries for an incident, strongest first.
 *
 * The feed's own `networkNames` come first: it extracts the network from
 * bracketed labels and from after a preposition ("Degraded Performance for
 * Solana Mainnet"), positions a leading-phrase scan cannot reach. Leading
 * phrases then cover the incident prose the feed's extractor declines — it is
 * tuned for maintenance titles, so "Robinhood Testnet Global Outage" yields
 * nothing from it.
 *
 * Longest phrase first, so "Robinhood Testnet" is tried before the bare
 * "Robinhood" — otherwise a testnet outage resolves to the mainnet chain.
 */
export function chainQueriesFromIncident(incident) {
  const queries = [];
  for (const name of incident?.networkNames ?? []) {
    if (typeof name === 'string' && isUsableCandidate(name)) queries.push(name.trim());
  }
  const title = String(incident?.title ?? '');
  // A bracketed label is a candidate, NOT noise — "*URGENT* [SUI] - Mainnet
  // upgrade" carries its chain only in the label, and an earlier version of this
  // function stripped it and found nothing at all. Same reading as the feed's own
  // extractor, which treats a leading label as the primary signal.
  for (const match of title.matchAll(/[[*]([^\]*]{2,40})[\]*]/g)) {
    const label = match[1].trim();
    if (isUsableCandidate(label)) queries.push(label);
  }
  // Leading dash left behind once a label is removed ("[SUI] - Mainnet …").
  const stripped = title.replace(LEADING_NOISE, '').replace(/^\s*[-–—:]\s*/, '').trim();
  const words = stripped.split(/\s+/).filter(Boolean);
  for (let n = Math.min(MAX_PHRASE_WORDS, words.length); n >= 1; n--) {
    const phrase = words.slice(0, n).join(' ').replace(/[:,.;]+$/, '').trim();
    if (isUsableCandidate(phrase)) queries.push(phrase);
  }
  // Dedupe case-insensitively, keeping the strongest occurrence of each.
  const seen = new Set();
  return queries.filter((q) => {
    const key = q.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Registry name for a chainId, or null before the registry has loaded. Never
// throws: a missing name must not cost the attribution itself.
function nameOf(chainId) {
  try {
    return getChainById(chainId)?.name ?? null;
  } catch {
    return null;
  }
}

function isUsableCandidate(phrase) {
  const text = String(phrase ?? '').trim();
  if (text.length < 2) return false;
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length === 0) return false;
  // At least one token has to be capable of naming a chain.
  return tokens.some((t) => !NOT_A_CHAIN.has(t) && !/^\d+$/.test(t) && t.length > 1);
}

/**
 * The chain an incident is about, or null when nothing resolves.
 *
 * Returns the FIRST candidate that resolves unambiguously — candidates are
 * ordered strongest-first, so first-wins is deliberate rather than lazy. Null is
 * a real answer here: attributing an incident to a chain nobody named would put
 * a fabricated outage on that chain's page.
 */
export function resolveIncidentChain(incident, { search = searchChains } = {}) {
  if (incident?.chains?.length) {
    const declared = incident.chains[0];
    // The feed sends a bare chainId for a declared chain, so the name is filled in
    // from the registry — otherwise a chain-level event reads "chain 137 null".
    const name = declared.name ?? nameOf(declared.chainId);
    return { chainId: declared.chainId, name, evidence: 'declared', query: null };
  }
  for (const query of chainQueriesFromIncident(incident)) {
    let hits;
    try {
      hits = search(query);
    } catch {
      continue;   // a resolver failure must not break incident normalization
    }
    if (!Array.isArray(hits) || hits.length === 0 || hits.length > MAX_AMBIGUITY) continue;
    const chain = hits[0];
    if (chain?.chainId == null) continue;
    return { chainId: chain.chainId, name: chain.name ?? null, evidence: 'title', query };
  }
  return null;
}
