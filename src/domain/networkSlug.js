/**
 * Canonical join key for a network name — the contract copy of the rule defined in
 * docs/SERVICE-CONTRACT.md (rule 11) and implemented identically in chains-status-news.
 * "Solana Mainnet", "solana mainnet" and "Solana" must collide, or every consumer
 * fuzzy-matches its own way and cross-feed joins silently disagree.
 *
 * Rule: lowercase → non-alphanumerics to spaces → strip trailing default-tier/generic
 * tokens (mainnet, network, chain, protocol, ledger — repeatedly) → join with '-'.
 *
 * Testnet tokens are deliberately NOT stripped: aliasing "Arbitrum Sepolia" to "arbitrum"
 * would join a testnet incident to a mainnet upgrade — the worst mismatch a correlation
 * consumer can make.
 */
const SLUG_STRIP_TRAILING = new Set(['mainnet', 'mainnets', 'network', 'chain', 'protocol', 'ledger']);

export function networkSlug(name) {
  if (typeof name !== 'string') return null;
  const tokens = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const trimmed = [...tokens];
  while (trimmed.length > 1 && SLUG_STRIP_TRAILING.has(trimmed[trimmed.length - 1])) trimmed.pop();
  const kept = trimmed.length > 0 && !SLUG_STRIP_TRAILING.has(trimmed.join('')) ? trimmed : tokens;
  return kept.join('-');
}

export function networkSlugs(names) {
  return [...new Set((names ?? []).map(networkSlug).filter(Boolean))];
}
