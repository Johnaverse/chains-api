import { resolveIncidentChain } from '../domain/incidentChains.js';

/**
 * Promote agreement between independent RPC providers into a CHAIN-level event.
 *
 * One provider reporting a chain degraded is a statement about that provider.
 * Two providers reporting the same chain, independently, is a statement about
 * the CHAIN — and reading it as two provider incidents buries the only fact that
 * matters. Observed live: chainstack ("Robinhood Testnet Global Outage", 06:47),
 * quicknode ("Robinhood Testnet : Degraded Performance", 07:08) and infura
 * ("Robinhood Testnet JSON-RPC Degraded", 07:30) — three providers, one chain,
 * inside 43 minutes, presented as three unrelated cards.
 *
 * Only chains with a chainId are correlated. Provider incidents naming non-EVM
 * networks (Solana, Sui, Stellar, Stacks, Aleo, Canton) have no entry in this
 * registry, so there is no chain to attribute them to; they stay provider-scoped
 * rather than being grouped under an invented identifier.
 */

// Independent providers required before an event is called chain-level. Two is
// the threshold because the second provider is what makes it independent
// evidence: a single provider cannot distinguish "the chain is broken" from
// "our path to the chain is broken".
export const MIN_PROVIDERS = 2;

// Maintenance and incidents are never merged. A coordinated upgrade window
// across two providers ("Sui - Mainnet - Upgrade to v1.76.1" at quicknode and
// blockdaemon) is a chain-level MAINTENANCE, and folding it in with an outage
// would report planned work as a failure.
function kindOf(incident) {
  return String(incident?.status ?? '').startsWith('maintenance') ? 'maintenance' : 'incident';
}

/**
 * Chain-level events, most-corroborated first.
 *
 * @param {Array} incidents normalized incidents (see sources/liveIncidents.js)
 * @param {object} [opts]
 * @param {number} [opts.minProviders] providers required to promote (default MIN_PROVIDERS)
 * @param {Function} [opts.resolve] chain resolver, injectable for tests
 */
export function correlateChainIncidents(incidents = [], { minProviders = MIN_PROVIDERS, resolve = resolveIncidentChain } = {}) {
  const groups = new Map();

  for (const incident of incidents) {
    // Provider pages only: a chain operator's own status page is already
    // chain-level, and counting it as corroboration would let one source
    // promote itself.
    if (!incident?.isProvider) continue;
    if (incident.ongoing !== true) continue;
    const providerId = incident.statusPage?.id;
    if (!providerId) continue;
    const chain = resolve(incident);
    if (chain?.chainId == null) continue;

    const key = `${chain.chainId}|${kindOf(incident)}`;
    if (!groups.has(key)) {
      groups.set(key, {
        chainId: chain.chainId,
        chainName: chain.name,
        kind: kindOf(incident),
        providers: new Map(),   // providerId -> its contributing incidents
        // How the chain was established across the group. A group corroborated
        // only by title matches is weaker evidence than one a provider declared,
        // and a reader cannot tell without this.
        evidence: new Set()
      });
    }
    const group = groups.get(key);
    group.evidence.add(chain.evidence);
    if (!group.providers.has(providerId)) group.providers.set(providerId, []);
    group.providers.get(providerId).push({
      provider: providerId,
      providerName: incident.statusPage?.name ?? providerId,
      title: incident.title,
      status: incident.status ?? null,
      impact: incident.impact ?? null,
      publishedAt: incident.publishedAt ?? null,
      publishedMs: incident.publishedMs ?? null,
      url: incident.url ?? null,
      incidentId: incident.incidentId ?? null,
      chainEvidence: chain.evidence,
      matchedOn: chain.query
    });
  }

  const events = [];
  for (const group of groups.values()) {
    if (group.providers.size < minProviders) continue;
    const reports = [...group.providers.values()].flat()
      .sort((a, b) => (a.publishedMs ?? 0) - (b.publishedMs ?? 0));
    const stamps = reports.map((r) => r.publishedMs).filter((ms) => Number.isFinite(ms));
    events.push({
      chainId: group.chainId,
      chainName: group.chainName,
      kind: group.kind,
      // The count IS the evidence — it is why this is chain-level at all.
      providerCount: group.providers.size,
      providers: [...group.providers.keys()].sort(),
      // First report, not "start": nobody published when the chain actually
      // broke, only when each provider noticed. Naming it firstReportedAt keeps
      // that distinction visible instead of implying an observed start time.
      firstReportedAt: stamps.length ? new Date(Math.min(...stamps)).toISOString() : null,
      latestReportAt: stamps.length ? new Date(Math.max(...stamps)).toISOString() : null,
      chainEvidence: [...group.evidence].sort(),
      reports
    });
  }

  // Most corroborated first, then most recently active: the strongest claim about
  // a chain should not sit below a weaker one just because it started earlier.
  return events.sort((a, b) => b.providerCount - a.providerCount
    || String(b.latestReportAt ?? '').localeCompare(String(a.latestReportAt ?? '')));
}
