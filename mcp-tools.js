import {
  getCachedData,
  searchChains,
  getChainById,
  getChainDetail,
  filterChainsByFamily,
  getAllChains,
  getAllRelations,
  getRelationsById,
  getEndpointsById,
  getAllEndpoints,
  getAllKeywords,
  validateChainData,
  traverseRelations,
  countChainsByTag,
  getRpcMonitoringResults,
  getRpcMonitoringStatus,
} from './dataService.js';
import { getL2BeatRefreshStatus } from './src/services/l2beatRefresher.js';
import { ensureChainRpcResults } from './src/services/chainRefresher.js';
import { getClientsByChain } from './clientsView.js';
import { getPricesForChains, getPriceForChain } from './priceService.js';
import {
  getAllStatusPages,
  getAllCoinStatusPages,
  getStatusPageByChainId,
  getStatusPageBySymbol,
} from './src/sources/statusPages.js';
import { getLiveIncidents } from './src/sources/liveIncidents.js';
import { getForumNews } from './src/sources/forumNews.js';
import { getWeb3News } from './src/sources/web3News.js';
import { getClientReleases, getFeedClient, getFeedClients, getNetworkClients, ClientFeedNotFoundError } from './src/sources/clientFeed.js';
import { getChainUpgrades } from './src/services/upgrades.js';
import { getForks } from './src/services/forks.js';
import { getTimeline } from './src/services/timeline.js';
import { getLatestRelease, parseRepo } from './src/services/latestRelease.js';
import { getProviderStats } from './src/services/providerStats.js';
import { checkChainHalt } from './src/services/chainHalt.js';
import { getNodeHardware, getNetworkResearch } from './src/sources/networkResearch.js';
import { ASSISTANT_TOOL_RESULT_MAX_CHARS } from './config.js';

/**
 * Get the list of MCP tool definitions (schemas)
 * @returns {Array} Array of tool definition objects
 */
export function getToolDefinitions() {
  return [
    {
      name: 'get_chains',
      description:
        'List blockchain chains, optionally filtered by tag (Testnet/L2/Beacon) and/or lifecycle status. Returns a CAPPED sample (default 50, max 200) — `totalMatched` is the full number of chains matching the filter, `count` is how many are in this response, and `truncated` is true when there are more. When `truncated` is true, tell the user you are showing the first `count` of `totalMatched` (a display limit) and offer to narrow by tag/status or search by name — do NOT present the sample as the complete list. For an exact total or category breakdown use get_stats; to find a specific chain use search_chains. Never treat a tag/category count as the overall registry total. Each chain carries a `price` object for its NATIVE currency, or null when the asset is unmapped (only ~29 of ~3000 chains are): `{usd, vol24h, marketCap, asOf, stale}`. `vol24h` is the ASSET’s 24-hour trading volume in USD — market activity, NOT chain throughput or transaction count — so chains sharing an asset legitimately report the SAME volume (Optimism, Base and Arbitrum all report ETH’s), and you must name the asset when you quote it rather than implying it is that chain’s own activity. `asOf` is when CoinGecko last moved the number and `stale` is true when that is over a day old — some assets are still quoted months after their market ended. When `stale` is true, `vol24h` and `marketCap` are null (a closed window is not a weaker answer, it is a different one) and `usd` is the LAST KNOWN price: quote it as of `asOf`, never as current. A null field means unknown, never zero.',
      inputSchema: {
        type: 'object',
        properties: {
          tag: {
            type: 'string',
            description: 'Optional tag to filter chains (e.g., "Testnet", "L2", "Beacon")',
            enum: ['Testnet', 'L2', 'Beacon'],
          },
          status: {
            type: 'string',
            description: 'Optional lifecycle status filter (e.g. "deprecated" for retired chains, "active" for live ones)',
            enum: ['active', 'incubating', 'deprecated', 'unknown'],
          },
          family: {
            type: 'string',
            description: 'Optional technology family filter: a case-insensitive substring of each chain’s free-text `family` label, so "OP Stack" matches "OP Stack", "OP Stack / Zora" and "Matchain / OP Stack" (other examples: "SKALE", "Polygon", "Arbitrum Orbit")',
          },
          limit: {
            type: 'number',
            description: 'Max chains to return (default 50, max 200)',
          },
        },
      },
    },
    {
      name: 'get_chain_by_id',
      description: 'Get detailed information about a specific blockchain chain by its chain ID. Includes a `price` object for the chain’s NATIVE currency (null when unmapped): `{usd, vol24h, marketCap, asOf, stale}`. `vol24h` is that ASSET’s 24-hour trading volume in USD — market activity, NOT chain throughput — so an L2 settling in ETH reports ETH’s volume, not its own; name the asset when quoting it. When `stale` is true the quote stopped moving at `asOf` (over a day ago): `vol24h` and `marketCap` are null and `usd` is the last known price, to be quoted as of `asOf` rather than as current. A null field is unknown, never zero. When researched, a `research` object lists the chain’s node/client `repositories` (each with a `kind` such as execution, consensus, rollup or node), whitepaper/document `papers` and short sourced `features`; every item carries a `status` (checked = fully verified, partial = evidence has gaps) and its `evidence` URLs — say when an item is only partially verified, and treat features as the project’s own claims, not tested facts. `research.forums` lists discussion boards the forum research tied to the chain, each with `relationship` (official / community_run / uncertain), `scope` (exact_network, project_family = the project’s shared board, ecosystem_shared, historical_network, uncertain = the board’s relationship to this chain could not be established) and `access` (read / inaccessible / archived when checked) — name the scope and say when a board was unreachable or archived; the chain’s `forumUrl` is the separately curated registry entry. `research.channels` lists public community / developer / support routes a primary project source links (`platform` discord / telegram / x / email / slack / gitter / matrix / wechat / contact_form / other), at most 12 (each platform gets a slot before any repeats), most specific first, with `channelsTotal` the full count and `channelsByPlatform` the full count per platform — a platform absent from `channelsByPlatform` has none listed, while one counted there but missing from `channels` was cut by the cap, so never say a chain has no Discord/Telegram/etc. unless `channelsByPlatform` lacks it: `relationship` official_operated / officially_endorsed (linked by the project, not necessarily run by it) / community_run / uncertain; `scope` as for forums; `access` = what the research could read without joining (public_preview_read, invite_unverified = invite link not validated, inaccessible, login_required, not_checked). When supplied, `availability` retains the dated observed state, activity and check time; read `channelsAvailabilityNote`. Closure can be retained alongside a later failed check; `historicalStatus` alone never establishes current closure. Cached observations do not establish current activity. Nobody joined or contacted these, so never promise a channel is active or that the team answers there, and name the scope when a route is project-wide or shared. Node hardware / setup requirements are NOT in this response: when `hasNodeRequirements` is true, call get_node_requirements for them.',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: {
            type: 'number',
            description: 'The chain ID to query (e.g., 1 for Ethereum mainnet, 137 for Polygon)',
          },
        },
        required: ['chainId'],
      },
    },
    {
      name: 'get_node_requirements',
      description:
        'Documented hardware and system requirements for running a node on a chain (CPU, memory, storage, bandwidth, OS, GPU), from the audited node hardware research. Use it for "what do I need to run a node / validator / RPC / archive node on X", "minimum vs recommended specs", "how much disk". Resolve the chain ID first (search_chains) if the user named the network. Returns one profile per node `role` × requirement `level` (minimum / recommended / example / unspecified) × `client`, most specific first. `client` is the software the figures were published for; when it is null the profile is generic for the chain — say "generic" rather than naming a client. Each requirement is a string in the publisher’s ORIGINAL unit ("memory capacity: 16 GB", "cpu cores: at least 4 cores"): quote units exactly as given, NEVER convert GB/GiB, Mbps/MB/s, cores/vCPU/threads, and never add up or average profiles. ALWAYS read and relay two caveats. (1) `identityStatus` is how firmly the research tied the documentation to THIS chain: confirmed = established; qualified = the project is right but the exact deployment or version has limits; unresolved = the documentation could not be matched to this chain — present unresolved figures as "documentation found for the project, not confirmed to apply to chain N". (2) each profile’s `scope`: exact_network = documented for this chain; project_family = the project’s generic sizing applied to this chain, NOT verified for it; historical_network = a past deployment, read the notes before use; uncertain = applicability could not be established, do not present it as verified sizing. Also mention `deployment` historical/deprecated and `verification` qualified. A profile with `prerequisiteFor` is a sourced prerequisite for another role, returned by that role filter while keeping its original `role`; it is not dedicated sizing for the requested role. Read the relationship’s condition, sizing, notes and sources; do not count the profile twice. A component that is absent was not documented — never say zero or unnecessary. These are published requirements, not benchmarks, and storage grows over time. `totalProfiles` is everything the research kept for the chain, `totalMatched` what survived your role/level filter (including explicitly sourced prerequisites for the requested role), `count` what fits in this response; `truncated` true means more matched profiles exist — narrow with `role` or `level` to see them. When `totalProfiles` is 0 the research found no publishable requirements for this chain, which is not proof none exist — say that and point to the project’s own node documentation; when `totalMatched` is 0 but `totalProfiles` is not, the chain has requirements for OTHER roles or tiers — say which roles exist (`availableRoles`) rather than that none are documented. Also returns `software` (or null): `repositories` = the node/client source repositories the research tied to the chain (`kind` execution / consensus / rollup / node / packaging / sdk / contracts, `status` checked or partial), and `observedClients` = client software and versions actually seen on the chain’s live RPC endpoints (what operators run today — evidence, not a requirement, and only for chains with monitored endpoints). Combine them when asked how to set up a node: hardware from `profiles`, software from `software`, each profile’s `client` naming the software its figures were published for.',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: {
            type: 'number',
            description: 'The chain ID (e.g., 1 for Ethereum mainnet, 8453 for Base)',
          },
          role: {
            type: 'string',
            description: 'Optional node role filter; includes explicitly sourced prerequisites while retaining their original role',
            enum: ['full_node', 'validator', 'archive', 'rpc', 'collator', 'sequencer', 'prover', 'light_node', 'other', 'unspecified'],
          },
          level: {
            type: 'string',
            description: 'Optional requirement tier filter',
            enum: ['minimum', 'recommended', 'example', 'unspecified'],
          },
          limit: {
            type: 'number',
            description: 'Max profiles to return (default 8, max 50)',
          },
        },
        required: ['chainId'],
      },
    },
    {
      name: 'search_chains',
      description: 'Search for blockchain chains by name or other attributes',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query string (e.g., "ethereum", "polygon")',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_endpoints',
      description: 'Get RPC, firehose, and substreams endpoints for a specific chain or all chains',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: {
            type: 'number',
            description: 'Optional chain ID. If provided, returns endpoints for that chain only. If omitted, returns all endpoints.',
          },
        },
      },
    },
    {
      name: 'get_relations',
      description: 'Get chain relationships (testnet/mainnet, L2/L1, etc.) for a specific chain or all chains',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: {
            type: 'number',
            description: 'Optional chain ID. If provided, returns relations for that chain only. If omitted, returns all relations.',
          },
        },
      },
    },
    {
      name: 'get_slip44',
      description: 'Get SLIP-0044 coin type information by coin type ID or all coin types',
      inputSchema: {
        type: 'object',
        properties: {
          coinType: {
            type: 'number',
            description: 'Optional coin type ID (e.g., 0 for Bitcoin, 60 for Ethereum). If omitted, returns all coin types.',
          },
        },
      },
    },
    {
      name: 'get_sources',
      description: 'Get the status of all data sources (theGraph, chainlist, chains, slip44)',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_keywords',
      description: 'Get extracted keywords such as blockchain names, network names, software client names, tags, and relation kinds',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'validate_chains',
      description: 'Validate chain data for potential quality issues across 17 cross-source validation rules (relation conflicts, slip44/name/status mismatches, L2BEAT consistency, RPC drift, deprecated-parent propagation, and more)',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_rpc_monitor',
      description: 'Get RPC monitor status and summary endpoint health counts across all chains (without per-chain endpoint listing)',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_stats',
      description: 'Get aggregate statistics: total chains, mainnets, testnets, L2s, beacons, RPC health percentage, and a lifecycle breakdown — activeChains (non-deprecated), deprecatedChains, and byStatus (counts per active/incubating/deprecated). Use for "how many chains", "how many are active/deprecated".',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'traverse_relations',
      description: 'BFS graph traversal of chain relations from a starting chain. Returns all reachable chains (nodes) and their relationship edges up to a given depth.',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: {
            type: 'number',
            description: 'The chain ID to start traversal from (e.g., 1 for Ethereum)',
          },
          depth: {
            type: 'number',
            description: 'Maximum traversal depth (1-5, default: 2)',
          },
        },
        required: ['chainId'],
      },
    },
    {
      name: 'get_rpc_monitor_by_id',
      description: 'Get RPC endpoint monitoring results for a specific chain by its chain ID. If the rolling monitor has not reached the chain yet (e.g. right after a deploy), its endpoints are checked live on demand, so a result is normally available.',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: {
            type: 'number',
            description: 'The chain ID to get RPC monitoring results for (e.g., 1 for Ethereum mainnet)',
          },
        },
        required: ['chainId'],
      },
    },
    {
      name: 'check_chain_halt',
      description:
        'Check whether a chain has STOPPED PRODUCING BLOCKS. Probes the chain\'s public RPC endpoints live for the latest block (height + block timestamp) and cross-checks a block explorer, then returns a verdict: "halted" (every responding source agrees on the same block and it is overdue), "delayed" (overdue but sources disagree), "endpoint_lagging" (chain is fine, a source is stuck on an old block — NOT a chain problem), "healthy", or "unknown" (fewer than two sources answered — this does NOT mean the chain is down). Use for "is X halted/stuck/stalled", "is X still producing blocks", "is X down". Distinct from get_rpc_monitor_by_id, which reports whether our probe could REACH an endpoint, and from get_live_incidents, which reports what the operator ANNOUNCED.',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: {
            type: 'number',
            description: 'The chain ID to check for a halt (e.g., 1 for Ethereum mainnet)',
          },
        },
        required: ['chainId'],
      },
    },
    {
      name: 'get_scaling_chains',
      description: 'List chains classified by L2BEAT as scaling solutions (Optimistic Rollup, ZK Rollup, Validium, Optimium). Returns each chain\'s L2BEAT view (stage, category, stack, DA layer, host chain, TVS) plus a refresher freshness block indicating whether the data is live or from the static fallback snapshot.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_l2beat_by_id',
      description: 'Get L2BEAT scaling data for a single chain by chain ID. Includes stage classification, category, stack, DA layer, host chain, TVS, activity, and per-chain freshness metadata.',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: {
            type: 'number',
            description: 'The chain ID to fetch L2BEAT data for (e.g., 42161 for Arbitrum One)',
          },
        },
        required: ['chainId'],
      },
    },
    {
      name: 'get_refresher_status',
      description: 'Get the unified rolling chain refresher\'s current state: tick interval, in-flight status, queue depth, sweep cursor, plus per-job-type status for L2BEAT batches and RPC sweeps. Useful for diagnosing data freshness or stuck refreshes.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_clients',
      description: 'Get execution client software (name, version, GitHub repo, language) running on a chain, aggregated from live RPC endpoints. Omit chainId to get a summary across all chains.',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: {
            type: 'number',
            description: 'Optional chain ID. If provided, returns clients for that chain only. If omitted, returns a summary across all chains with monitoring data.',
          },
        },
      },
    },
    {
      name: 'get_status_pages',
      description: 'Get the curated registry of operator status/incident pages. Returns chain-keyed projects (each with the chainIds it covers) plus coin/symbol-keyed entries for networks not represented by a chainId (e.g. Solana, Sui).',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_status_page_by_chain',
      description: 'Get the operator status/incident page covering a specific chain by its chain ID (e.g. 8453 for Base → base-l2.statuspage.io).',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: {
            type: 'number',
            description: 'The chain ID to look up a status page for (e.g., 1 for Ethereum, 8453 for Base)',
          },
        },
        required: ['chainId'],
      },
    },
    {
      name: 'get_status_page_by_symbol',
      description: 'Get the operator status/incident page for a coin/network keyed by symbol rather than chain ID (e.g. SOL for Solana). Case-insensitive.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: {
            type: 'string',
            description: 'The coin/network symbol to look up (e.g., "SOL", "SUI", "AAVE")',
          },
        },
        required: ['symbol'],
      },
    },
    {
      name: 'get_live_incidents',
      description:
        'Get LIVE incidents and scheduled maintenance from chain operator status pages and RPC provider status pages (Infura, QuickNode, dRPC, Pinax). Use for questions like "is X down", "any incidents today", "provider outages". Each item carries a lifecycle `status` and an `ongoing` flag: for "is X down right now" pass ongoing=true; for "scheduled/upcoming maintenance" pass status="maintenance_scheduled" (its publishedAt is when the maintenance starts). `chainLevel` is the important one for "is CHAIN X healthy": each entry is a chain that TWO OR MORE independent RPC providers are reporting at the same time, which is evidence about the chain rather than about one provider — lead with it and say how many providers agree. It is computed across all ongoing provider incidents, so it is present even when a chainId filter narrowed `incidents`. A provider incident usually does not declare a chain, so `chainId` also matches a chain read from the incident title; `chainEvidence` says which ("declared" or "title"), and an incident naming a non-EVM network with no chainId in the registry is never attributed at all. Near-real-time (cached ~60s).',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['chain', 'provider', 'all'],
            description: 'chain = network operator incidents, provider = RPC provider incidents, all = both (default)',
          },
          chainId: {
            type: 'number',
            description: 'Only incidents affecting this chain ID',
          },
          provider: {
            type: 'string',
            description: 'Only incidents from this RPC provider id (e.g. "infura", "quicknode")',
          },
          ongoing: {
            type: 'boolean',
            description: 'true = only currently-active incidents/outages (best for "is X down right now"); false = only non-active items (resolved, completed, or not-yet-started maintenance)',
          },
          status: {
            type: 'string',
            enum: [
              'investigating', 'identified', 'monitoring', 'resolved',
              'maintenance_scheduled', 'maintenance_in_progress', 'maintenance_completed',
              'operational', 'degraded', 'partial_outage', 'major_outage', 'unknown',
            ],
            description: 'Only incidents in this exact lifecycle state. Use "maintenance_scheduled" for upcoming/planned maintenance, or "investigating"/"identified"/"monitoring" for open incidents',
          },
          limit: {
            type: 'number',
            description: 'Max incidents to return (default 30, max 100)',
          },
        },
      },
    },
    {
      name: 'get_forum_news',
      description:
        'Get recent posts from official chain community/governance forums (Ethereum Magicians, Arbitrum DAO, …), keyed by chain ID. Use for questions about governance discussions, proposals, upgrades being debated, or community news. Near-real-time (cached ~60s).',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: {
            type: 'number',
            description: 'Only posts tied to this chain ID',
          },
          forum: {
            type: 'string',
            description: 'Only posts from this forum id (e.g. "ethereum", "arbitrum")',
          },
          limit: {
            type: 'number',
            description: 'Max posts to return (default 15, max 50)',
          },
        },
      },
    },
    {
      name: 'get_chain_upgrades',
      description:
        'Get the cross-feed upgrade timeline: scheduled/completed network upgrades and maintenance windows with the REQUIRED SOFTWARE ({client, version} operators must run), urgency (standard/urgent/mandatory), activation time WITH ITS EVIDENCE, incidents that followed on the same network within 24h (labelled suspectedCause: "upgrade" — temporal correlation, not asserted causation), and related forum discussion + news coverage. Use for "when is the next upgrade for X", "what version is required", "did the upgrade cause incidents". NOT for a fork schedule: this returns one entry per PROVIDER WINDOW, so a single fork appears here several times over. For forks themselves — one entry per fork per network, with every provider window attached — use get_forks. `network` accepts a name for chains with no EVM chain ID (e.g. "Solana", "Canton"). NEVER read `activationAt` without `activationEvidence`: `window`/`scheduled` mean a stated time you may count down to; `started`/`completed` are OBSERVED and approximate (`completed` is an upper bound on the run, not its start, so say "completed by"); `announced` means the provider announced the upgrade and never named a day — `activationAt` is null and you must say the date is not announced yet rather than implying one. Evidence strength wins over recency, so a later exact window overrides an earlier undated announcement. `windowMinutes`/`windowEndAt` exist only for `window` evidence. On followedByIncidents, `durationEvidence` is `observed` (resolvedAt is real), `ongoing` (still open), or `unpublished` (the page never said when it ended — do not state a duration). Returns a capped list with totalMatched/truncated — say when you are showing a subset.',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: {
            type: 'number',
            description: 'Only upgrades touching this chain ID',
          },
          network: {
            type: 'string',
            description: 'Network name or slug (e.g. "Solana Mainnet", "gnosis") — use for networks that have no EVM chain ID',
          },
          limit: {
            type: 'number',
            description: 'Max upgrades to return (default 20, max 50)',
          },
        },
      },
    },
    {
      name: 'get_forks',
      description:
        'Get FORKS as entities: one entry per fork per network, grouped across ALL feeds — status pages (the network\'s and each provider\'s maintenance windows), governance/research forums, news (the project\'s own blog = primary, outlets = secondary), and client release notes (feed `release`: the client team\'s own release/changelog announcing the activation, primary evidence) where that feed is configured. A fork produces many events (each provider posts its own maintenance window), so get_chain_upgrades shows the same fork repeatedly — this collapses them. Use for "what forks are coming", "when does X fork", "is the fork still on". Only consensus forks / network upgrades are listed by default (`kind: "fork"`): ordinary software updates that merely carried a fork marker — client releases, RPC patches, provider infrastructure work — are `kind: "upgrade"` and appear only with include="upgrades"; `byKind` counts both. Each fork carries: `name` (codename such as "Protocol 28", or null when the text marked a fork without naming one), `network` (plus `networks` when one set of events covered several), `phase`, `activationAt` WITH `activationEvidence` and `activationPrecision` (`day` = only the date was given, not the time — say "on <date>", never a time of day), `activationBlock`, `state`, `sources` (which status pages, forums or outlets reported it — more than one means independent confirmation), `feeds` (status / forum / news / release) and `events`, each with its own claimed `activationAt`. The fork\'s activationAt is the strongest claim (the network or a primary source over secondary news), except that newer non-secondary sources moving the date by more than a day are treated as a reschedule; when `feeds` is only ["news"], attribute it ("CoinDesk reports…") rather than stating it as the network\'s schedule. A top-level `feeds` says which feeds answered — if one is not ok, say forks from it may be missing or out of date (`stale: true` means its forks are from an earlier fetch). NEVER read activationAt without activationEvidence: `stated` is a time a source actually gave; `observed` is derived from a block height already reached; `estimated` is a height still ahead multiplied by the average block rate, so it is an order-of-magnitude answer and must be described as approximate, never as a schedule. `phase` is upcoming / past / cancelled / unscheduled — `unscheduled` means no source has named a date (or the only stated date was implausible and dropped — see the event `implausibleActivationAt`), so say the date is not announced rather than implying one; `completed` forks are `past` even with no date, and `cancelled` only ever appears when a source said so (a quietly dropped fork stays upcoming until its date passes). Pass scheduledOnly=true for a calendar view. Returns a capped list with totalMatched/truncated plus byPhase counts over everything matched — quote byPhase for totals rather than counting the rows shown.',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: { type: 'number', description: 'Only forks touching this chain ID' },
          phase: {
            type: 'string',
            enum: ['upcoming', 'past', 'cancelled', 'unscheduled'],
            description: 'Filter by lifecycle phase'
          },
          scheduledOnly: {
            type: 'boolean',
            description: 'Only forks with a known activation time — what a calendar needs'
          },
          include: {
            type: 'string',
            enum: ['upgrades'],
            description: 'Pass "upgrades" to also list ordinary software updates that carried a fork marker (kind "upgrade"). Omit for real forks only.'
          },
          limit: { type: 'number', description: 'Max forks to return (default 50, max 200)' }
        },
      },
    },
    {
      name: 'get_timeline',
      description:
        'Get the EVENT TIMELINE: hardforks, software updates and maintenance as events, each with everything the feeds say about it grouped under it — `releases` (the client releases that ship it: repo, version, mandatory), `providerUpdates` (every RPC provider\'s rollout window for it, with status and activation evidence), `news` (articles and forum posts about it) and `followedByIncidents` (incidents on the same network within 24h after activation: suspected, never asserted causation). Use for a chain\'s HARDFORK HISTORY (chainId + type="hardfork": every fork the feeds know for that chain, newest first after any upcoming one), for "what happened around the X fork" (which clients shipped it, which providers rolled it out, what broke after), and for "what software updates are coming for X". `type`: `hardfork` = a consensus fork / network upgrade; `software_update` = a client version rolled out with no fork behind it (provider windows for one version are grouped across providers) — planned work, NEVER an incident, so do not report it as an outage; `maintenance` = a provider window naming no software. History reaches as far back as the feeds\' archives: client releases go back years, provider status posts only weeks — a fork with no `providerUpdates` before that window is not evidence that no provider rolled it out. `activationEvidence`: `stated`/`window`/`scheduled` = a time a source gave; `observed`/`started`/`completed` = seen happening (approximate); `estimated` = derived from a block height ahead (approximate); `released` = only the release date is known; null with `phase: "unscheduled"` = no date announced — say so rather than implying one. `layerName` is the name a client used when it differs from the combined one (Glamsterdam = Amsterdam + Gloas). `counts` gives the full size of each group; the lists are capped at 2 here. `sources` says which feeds answered — a missing release feed means most fork history is missing. Returns totalMatched/truncated with byType and byPhase over everything matched — quote those for totals.',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: { type: 'number', description: 'Only events touching this chain ID — with type="hardfork", its hardfork history' },
          type: {
            type: 'string',
            description: 'Comma list of hardfork, software_update, maintenance. Omit for all three.'
          },
          phase: {
            type: 'string',
            enum: ['upcoming', 'past', 'cancelled', 'unscheduled'],
            description: 'Filter by phase'
          },
          since: { type: 'string', description: 'ISO time; only events activating at/after it (drops undated)' },
          until: { type: 'string', description: 'ISO time or YYYY-MM-DD; only events activating at/before it (drops undated)' },
          limit: { type: 'number', description: 'Max events to return (default 5, max 100). Results over ~8000 characters are cut off, so ask for more only with a chainId or type filter.' }
        },
      },
    },
    {
      name: 'get_provider_stats',
      description:
        'Get per-RPC-provider quality indicators (Infura, QuickNode, Alchemy, dRPC, Chainstack, …): incidents30d, ongoingNow (open INCIDENTS only), ongoingMaintenance (planned windows in progress — never call these outages), maintenance30d, chainsAffected30d, oldestOngoingAt (start of the longest-running open incident), resolutionHours (median/avg time-to-resolve, usually null), availability, endpointReachability, and chain coverage. For "which provider is most reliable/available" use `availability`: CHAIN-WEIGHTED over three windows (last24h/last7d/last30d), each {percent, chainHoursLost} where percent = 1 − chain-hours lost / (chainsSupported × window hours) — so 1 of 10 supported chains down for a full 24h window is 90%, not 0%. chainsSupported is ONLY what the provider lists on its own status page; when that coverage is unavailable the percents are null with a note. It is SELF-REPORTED: a provider that never posts incidents scores a perfect 100 (a silent status page looks perfect), so always say it is self-reported. Most status pages publish an incident only ONCE, at resolution, so its duration is unknown and it is EXCLUDED from the percent rather than charged as downtime — compare availability.measuredIncidents against unknownDurationIncidents before ranking providers on it, and when measuredIncidents is 0 say the percent means "nothing open right now", not "a clean month". Use disclosure.comparable to decide whether a provider belongs in a ranking at all; a "partial window" note means feed retention is younger than the window. `endpointReachability` ({working, total, percent, registryChains}) measures whether REGISTRY-LISTED endpoint URLs answer chains-api\'s probes — keyed/stale/geo-blocked registry URLs fail by design, so it is a registry data-quality signal; do NOT present it as provider uptime.',
      inputSchema: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            description: 'Only this provider id (e.g. "infura", "quicknode", "alchemy"). Omit for all providers, sorted by incidents30d descending',
          },
        },
      },
    },
    {
      name: 'get_web3_news',
      description:
        'Get recent blockchain/web3 ecosystem news from curated publishers (Ethereum Foundation blog, Vitalik\'s blog, Consensys, CoinDesk, Decrypt, The Block). Use for "what is new with X", upgrade/hard-fork announcements, research, funding and ecosystem developments. Distinct from the other feeds: get_live_incidents is outages/maintenance and get_forum_news is governance discussion — this is what the ecosystem publishes about itself. `weight` separates protocol/research sources ("primary") from news desks that also cover markets ("secondary"); prefer primary for protocol facts. Returns a capped list (default 15, max 50) with `totalMatched`; when it exceeds `count`, say you are showing the most recent subset. Near-real-time (cached ~60s).',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: {
            type: 'number',
            description: 'Only news mapped to this chain ID. Mapping is precision-first, so many articles carry no chain — omit this for broad questions',
          },
          sourceId: {
            type: 'string',
            description: 'Only news from this source id (e.g. "ethereum-foundation", "coindesk", "vitalik")',
          },
          weight: {
            type: 'string',
            enum: ['primary', 'secondary'],
            description: 'primary = protocol/research publishing (EF, Vitalik, Consensys), secondary = news desks including market coverage',
          },
          limit: {
            type: 'number',
            description: 'Max articles to return (default 15, max 50)',
          },
        },
      },
    },
    {
      name: 'get_client_releases',
      description:
        'Get recent blockchain CLIENT software releases (geth, Nethermind, Lighthouse, op-node, …) read from their GitHub/GitLab releases and changelogs, newest first. Use for "latest version of X", "is this release mandatory", "which client release ships fork Y". `release.mandatory` = the notes say operators must upgrade; `enrichment.fork` = the hard fork the release announces (name, network, activationAt/activationBlock/activationEpoch, state). `chainsFrom` says where the chains come from: `fork` = the networks of the hard fork the release announces, `release` = named in the notes, `repository` = every network the repo serves, not ones the notes named. `review` = the notes carry fork or upgrade-obligation wording the model did not confirm (quotes included): report it as a POSSIBLE fork / mandatory upgrade to verify, never as \"no fork\". For fork dates across all sources prefer get_forks. Returns a capped list (default 15, max 50) with `totalMatched` (null = completeness unknown; `note` says why — tell the user it may be partial).',
      inputSchema: {
        type: 'object',
        properties: {
          client: {
            type: 'string',
            description: 'Case-insensitive text matched against the repo slug and client name (e.g. "geth", "lighthouse")',
          },
          repo: {
            type: 'string',
            description: 'Exact repository: "owner/repo" for GitHub (e.g. "ethereum/go-ethereum"), or prefixed "github:owner/repo" / "gitlab:owner/repo"',
          },
          chainId: {
            type: 'number',
            description: 'Only releases attributed to this chain ID',
          },
          fork: {
            type: 'boolean',
            description: 'true = only releases that announce a hard fork',
          },
          since: {
            type: 'string',
            description: 'Only releases published on/after this ISO date or date-time (e.g. "2026-09-01")',
          },
          until: {
            type: 'string',
            description: 'Only releases published on/before this ISO date or date-time; a bare date includes that whole day (UTC)',
          },
          limit: {
            type: 'number',
            description: 'Max releases to return (default 15, max 50)',
          },
        },
      },
    },
    {
      name: 'get_latest_release',
      description:
        'The LATEST release of one client repository, answered field by field: `latest.version` and `latest.url` (the release link), `hardfork.included` (the release schedules a hard fork; `forks` lists each with network, state and activation), `mandatory` (operators must upgrade), `security.update` (a security release: `source: advisory` = a published GitHub advisory names this version as patched, with severity; `source: notes` = the notes say so, `quote` is the line; `scope: dependency` = only a library/toolchain bump), and `flags.changed` (CLI flags or config keys added/removed/deprecated/renamed/default changed, each with its `quote`). Use for "what is the latest version of X", "is the latest X release mandatory / a security update / a hard fork", "does it change any flags". `null` = UNKNOWN (not classified yet, or no notes) — say it is unknown, never "no". `hardfork.review` = possible fork wording the model did not confirm: report it as a possible fork to verify. Stable releases unless includePrerelease; `newerPrerelease` names a newer prerelease. A monorepo returns `components` (newest release of each): ask which one, or pass `component`. For many releases or a date range use get_client_releases.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: {
            type: 'string',
            description: 'The repository: "owner/repo" for GitHub (e.g. "ethereum/go-ethereum"), "github:owner/repo" / "gitlab:owner/repo", or its URL',
          },
          component: {
            type: 'string',
            description: 'For a monorepo, the component (e.g. "op-node" in ethereum-optimism/optimism)',
          },
          includePrerelease: {
            type: 'boolean',
            description: 'true = the newest release even if it is a prerelease/RC (default false)',
          },
        },
        required: ['repo'],
      },
    },
    {
      name: 'get_client_activity',
      description:
        'How actively a node CLIENT is developed and how much of its open work is flagged as critical: default-branch commits and merged pull requests in the last 30/90 days, open issues and PRs, issues opened in 30 days, open issues labeled as bugs or as critical/security/priority (with the label names), published GitHub security advisories (count by severity, newest three), a development `level` (active / moderate / low / dormant / archived) and an `attention` level (high / elevated / normal) with its reasons. Use for "is X still maintained", "how active is X", "does X have critical open issues or recent security advisories". Label counts say what maintainers labeled, not a code audit — say so. Refreshed daily; `activity: null` means not collected yet. Also returns `lineage`: the upstream client this one customizes (e.g. a chain\'s geth fork → Geth) and the clients customizing it with their networks (`networks` is a sample of at most ten; `networkCount` is the full count); `via` is `github-fork`/`gitlab-fork` (recorded by the host), `known` (well-known parent) or `name` (inferred from names — call it a likely link, not a fact). Use for "which chains run a customized geth", "what is X based on". Give `repo` for one repository, or `client` (a name such as "lighthouse") for up to `limit` matching repositories.',
      inputSchema: {
        type: 'object',
        properties: {
          client: {
            type: 'string',
            description: 'Client name or repo text, e.g. "geth", "lighthouse", "op-node"',
          },
          repo: {
            type: 'string',
            description: 'Exact repository: "owner/repo" for GitHub, or "github:owner/repo" / "gitlab:owner/repo"',
          },
          limit: {
            type: 'number',
            description: 'Max repositories for a `client` search (default 3, max 5)',
          },
        },
      },
    },
    {
      name: 'get_network_clients',
      description:
        'List the node/client software repositories known to serve a chain (execution, consensus, node, sequencer, …), each with the kinds it plays on that chain, how many networks it serves (`networkCount`), its latest release and latest announced fork, and a compact `activity` (development level, attention level, commits/merged PRs in 30 days, open and critical-labeled issues, advisories in the last year; null until collected). Use for "which clients run X" and "what is the latest geth version for X"; for one client\'s full activity call get_client_activity. Different from get_clients, which reports what live RPC endpoints self-report.',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: {
            type: 'number',
            description: 'The chain ID',
          },
        },
        required: ['chainId'],
      },
    },
  ];
}

// --- Response helpers ---

function textResponse(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

// No pretty-printing: the assistant caps tool results by character count, and indentation
// is the first thing to spend that budget on when a chain has two dozen profiles.
function compactResponse(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
  };
}

function errorResponse(error, message) {
  const payload = message ? { error, message } : { error };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: true,
  };
}

function isValidChainId(chainId) {
  return typeof chainId === 'number' && !Number.isNaN(chainId);
}

// --- Individual tool handlers ---

const GET_CHAINS_DEFAULT_LIMIT = 50;
const GET_CHAINS_MAX_LIMIT = 200;

async function handleGetChains(args) {
  let chains = getAllChains();
  if (args.tag) {
    chains = chains.filter((chain) => chain.tags?.includes(args.tag));
  }
  if (args.status) {
    chains = chains.filter((chain) => (chain.status || 'unknown') === args.status);
  }
  chains = filterChainsByFamily(chains, args.family);
  // The registry has ~3000 chains; returning them all (with a price lookup
  // each) is a huge payload that overflows an LLM's context and makes it lose
  // the true total. Cap the list, report totalMatched so callers still get the
  // honest count, and only price-enrich the slice actually returned.
  const totalMatched = chains.length;
  const limit = Math.max(1, Math.min(Number(args.limit) || GET_CHAINS_DEFAULT_LIMIT, GET_CHAINS_MAX_LIMIT));
  const sliced = chains.slice(0, limit);
  const priceMap = await getPricesForChains(sliced.map((c) => c.chainId));
  const enrichedChains = sliced.map((chain) => ({
    ...chain,
    price: priceMap.get(chain.chainId) ?? null,
  }));
  return textResponse({
    totalMatched,
    count: enrichedChains.length,
    truncated: totalMatched > enrichedChains.length,
    chains: enrichedChains,
  });
}

// Channel research can list dozens of routes per chain (Ethereum: 28), each with notes and
// evidence — far past the tool-result cap. The model gets the identifying fields of the
// first few, already ordered most specific (exact network, official) first.
const CHAIN_CHANNELS_LIMIT = 12;
function compactChannelAvailability(channel) {
  const checks = Array.isArray(channel.current_availability_checks) ? channel.current_availability_checks : [];
  const newest = entries => entries.reduce((chosen, check) => !chosen || (Date.parse(check.checked_at_utc) || 0) > (Date.parse(chosen.checked_at_utc) || 0) ? check : chosen, null);
  const latest = newest(checks);
  if (!latest) return null;
  // A failed later canonical lookup cannot erase an explicit closure observation.
  // Historical-only cache evidence (Zeniq) is never promoted to current closure.
  const closure = newest(checks.filter(check => check.status === 'removed_or_closed_explicit'));
  const observation = closure ?? latest;
  return {
    status: observation.status,
    checkedAt: observation.checked_at_utc ?? null,
    activity: observation.activity_status ?? 'unknown',
    ...(observation.observed_historical_status && { historicalStatus: observation.observed_historical_status }),
    ...(latest !== observation && { latestCheck: { status: latest.status, checkedAt: latest.checked_at_utc ?? null } })
  };
}
function compactChannel(channel) {
  const { platform, title, url, mode, relationship, scope, access, verification } = channel;
  const availability = compactChannelAvailability(channel);
  return { platform, title, url, mode, relationship, scope, access, verification, ...(availability && { availability }) };
}

// A plain head slice let one platform fill the cap — Algorand's first 12 were 11 regional
// Telegram groups, so the model said it had no Discord. Taking the best remaining channel of
// each platform in turn gives every platform a slot first; the picks keep their original order.
// Not Map.groupBy: the image runs Node 20, which lacks it (CI tests on 22).
function groupByPlatform(channels) {
  const groups = new Map();
  for (const c of channels) {
    if (!groups.has(c.platform)) groups.set(c.platform, []);
    groups.get(c.platform).push(c);
  }
  return groups;
}

function pickChannels(channels, limit) {
  const byPlatform = groupByPlatform(channels);
  const picked = new Set();
  for (let round = 0; picked.size < limit && picked.size < channels.length; round++) {
    for (const group of byPlatform.values()) {
      if (group[round] && picked.size < limit) picked.add(group[round]);
    }
  }
  return channels.filter((c) => picked.has(c));
}

async function handleGetChainById(args) {
  const { chainId } = args;
  if (!isValidChainId(chainId)) {
    return errorResponse('Invalid chain ID');
  }
  const chain = getChainDetail(chainId);
  if (!chain) {
    return errorResponse('Chain not found');
  }
  const price = await getPriceForChain(chainId);
  // The research block can run to tens of KB, and the assistant truncates tool results —
  // so price goes before it, and the hardware profiles (the largest part) are left to
  // get_node_requirements, which the model is told to call when hasNodeRequirements is set.
  const { research, ...rest } = chain;
  const { hardware, ...slimResearch } = research ?? {};
  if (slimResearch.channels?.length > 0) {
    const all = slimResearch.channels;
    slimResearch.channelsTotal = all.length;
    slimResearch.channelsByPlatform = Object.fromEntries([...groupByPlatform(all)].map(([p, g]) => [p, g.length]));
    slimResearch.channels = pickChannels(all, CHAIN_CHANNELS_LIMIT).map(compactChannel);
    if (slimResearch.channels.some(channel => channel.availability)) {
      slimResearch.channelsAvailabilityNote = 'Dated observations, not live checks: content may be cached and current status/activity remain unverified. removed_or_closed_explicit is a closure observation; a later failed lookup does not erase it. historicalStatus is historical cache evidence only. Identity verification and access are separate. Full dated evidence and cache caveats are in REST /chains/' + chainId + '.';
    }
  }
  const payload = { ...rest, price, hasNodeRequirements: hardware?.profiles?.length > 0 };
  if (research && Object.keys(slimResearch).some((key) => key !== 'updatedAt')) payload.research = slimResearch;
  return compactResponse(payload);
}

// Profiles that are documented for this exact chain come first, then the common roles, and
// minimum before recommended — so a capped result still carries the answer most people want.
const ROLE_ORDER = ['full_node', 'validator', 'rpc', 'archive', 'sequencer', 'prover', 'collator', 'light_node', 'other', 'unspecified'];
const LEVEL_ORDER = ['minimum', 'recommended', 'example', 'unspecified'];
const SCOPE_ORDER = ['exact_network', 'project_family', 'historical_network', 'uncertain'];
const QUALIFIER_TEXT = { at_least: 'at least ', at_most: 'at most ', approximately: 'approximately ' };
const NODE_REQUIREMENTS_DEFAULT_LIMIT = 8;
const NODE_REQUIREMENTS_MAX_LIMIT = 50;

const rank = (order, value) => {
  const index = order.indexOf(value);
  return index < 0 ? order.length : index;
};

/** "memory capacity: at least 16 GB (grows)". Units are the publisher's, never converted. */
function describeRequirement(r) {
  let value;
  if (r.qualifier === 'range' && (r.min != null || r.max != null)) value = `${r.min ?? '?'}–${r.max ?? '?'}`;
  else if (typeof r.value === 'boolean') value = r.value ? 'yes' : 'no';
  else value = `${QUALIFIER_TEXT[r.qualifier] ?? ''}${r.value}`;
  const unit = r.unit ? ` ${r.unit}` : '';
  const notes = r.notes ? ` (${r.notes})` : '';
  return `${r.component} ${String(r.metric).replace(/_/g, ' ')}: ${value}${unit}${notes}`;
}

/** "mainnet-legacy-archival.tar.zst, compressed snapshot download: 2.9 TB / 2.9 TiB (2023-06-14 08:13)", then the download URL when known. */
function describeSnapshot(a) {
  const sizes = [...new Set((a.sizes ?? []).map((s) => `${s.value}${s.unit ? ` ${s.unit}` : ''}`))].join(' / ');
  const kind = a.type ? `, ${a.type.replace(/_/g, ' ')}` : '';
  const url = a.url ? ` <${a.url}>` : '';
  return `${a.file ?? 'snapshot'}${kind}${sizes ? `: ${sizes}` : ''}${a.publishedAt ? ` (${a.publishedAt})` : ''}${url}`;
}

/** The returned profiles' other services, once each (OP repeats the same two on every profile). */
function dependenciesOf(profiles) {
  const byKey = new Map();
  for (const d of profiles.flatMap((p) => p.dependencies ?? [])) {
    // Same service, different condition: both stay, or a profile's condition is lost.
    const key = `${d.component}\u0000${d.requiredWhen ?? ''}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      component: d.component,
      ...(d.requiredWhen && { requiredWhen: d.requiredWhen }),
      ...(d.clientOptions?.length && { clientOptions: d.clientOptions }),
      ...(typeof d.selfHosted === 'boolean' && { selfHosted: d.selfHosted }),
      ...(d.hosting && { hosting: d.hosting }),
      ...(d.sizing && { sizing: d.sizing }),
      ...(d.requirements?.length && { requirements: d.requirements.map(describeRequirement) }),
      // Notes carry the qualification ("external L1 endpoints are fine"); sources are capped like a profile's.
      ...(d.notes && { notes: d.notes }),
      ...(d.sources?.length && { sources: d.sources.slice(0, 3) }),
    });
  }
  return [...byKey.values()];
}

/**
 * What to run, next to what to run it on: the node/client repositories the research tied
 * to the chain, and the client software actually observed on its live RPC endpoints.
 * Null when neither has anything, so the model does not read an empty list as "no software".
 */
function softwareFor(chainId) {
  const repositories = (getNetworkResearch(chainId)?.repositories ?? []).map((r) => ({
    repo: r.repo ?? r.url,
    url: r.url,
    kind: r.kind,
    status: r.status,
    ...(r.scope && { scope: r.scope }),
    ...(r.deployment && { deployment: r.deployment }),
    ...(r.notes && { notes: r.notes }),
    ...(r.reviewedAt && { reviewedAt: r.reviewedAt }),
  }));
  const observedClients = (getClientsByChain(chainId)?.clients ?? []).map((c) => ({
    name: c.name,
    repo: c.repo ?? null,
    layer: c.layer ?? null,
    nodes: c.nodeCount,
    versions: (c.versions ?? []).slice(0, 3).map((v) => v.version),
  }));
  if (!repositories.length && !observedClients.length) return null;
  return { repositories, observedClients };
}

function handleGetNodeRequirements(args) {
  const { chainId, role, level } = args;
  if (!isValidChainId(chainId)) {
    return errorResponse('Invalid chainId', 'chainId must be a positive integer');
  }
  const chain = getChainById(chainId);
  if (!chain) {
    return errorResponse('Not found', `No chain with chainId ${chainId}`);
  }
  const base = { chainId: chain.chainId, name: chain.name, family: chain.family ?? null };
  const software = softwareFor(chainId);
  const hardware = getNodeHardware(chainId);
  if (!hardware) {
    return compactResponse({
      ...base,
      totalProfiles: 0,
      count: 0,
      truncated: false,
      profiles: [],
      software,
      message: 'This chain is not covered by the node hardware research. That is not proof that no requirements exist — point the user to the project’s own node documentation.',
    });
  }
  if (hardware.profiles.length === 0) {
    return compactResponse({
      ...base,
      researchStatus: hardware.status,
      identityStatus: hardware.identityStatus,
      checkedAt: hardware.checkedAt,
      totalProfiles: 0,
      count: 0,
      truncated: false,
      profiles: [],
      software,
      researchNotes: hardware.notes,
      sourcesChecked: (hardware.sources ?? []).slice(0, 5).map((s) => ({ url: s.url, access: s.access ?? null, notes: s.notes ?? null })),
      message: `The node hardware research checked this chain and found no publishable requirements (${hardware.status === 'inaccessible' ? 'its documentation could not be read' : 'none documented'}); researchNotes says why and sourcesChecked where it looked. This is not proof that none exist — point the user to the project’s own node documentation.`,
    });
  }
  let profiles = hardware.profiles;
  // A sourced prerequisite keeps its original role and occurs only once, even when
  // both a direct role match and a prerequisite relationship would include it.
  if (role) profiles = profiles.filter((p) => p.role === role || p.prerequisiteFor?.some((link) => link.role === role));
  if (level) profiles = profiles.filter((p) => p.level === level);
  profiles = [...profiles].sort((a, b) =>
    // Unresolved last: its source or applicability was never settled.
    (a.verification === 'unresolved') - (b.verification === 'unresolved')
    || rank(SCOPE_ORDER, a.scope) - rank(SCOPE_ORDER, b.scope)
    || rank(ROLE_ORDER, a.role) - rank(ROLE_ORDER, b.role)
    || rank(LEVEL_ORDER, a.level) - rank(LEVEL_ORDER, b.level));
  const limit = Math.max(1, Math.min(Number(args.limit) || NODE_REQUIREMENTS_DEFAULT_LIMIT, NODE_REQUIREMENTS_MAX_LIMIT));
  const shown = profiles.slice(0, limit);
  const candidates = shown.map((p) => ({
    id: p.id,
    role: p.role,
    level: p.level,
    scope: p.scope,
    client: p.clientVersion ? `${p.client} ${p.clientVersion}` : p.client,
    deployment: p.deployment,
    verification: p.verification,
    ...(p.prerequisiteFor?.length && { prerequisiteFor: p.prerequisiteFor }),
    ...(p.requiredWhen && { requiredWhen: p.requiredWhen }),
    ...(p.sizing && { sizing: p.sizing }),
    requirements: p.requirements.map(describeRequirement),
    ...(p.snapshotArtifact && { snapshot: describeSnapshot(p.snapshotArtifact) }),
    notes: p.notes,
    // A quoted snapshot size cites its own listing (OP's 2.9 TiB is datadirs.optimism.io), so its
    // sources go first, before the cap of 3 can drop them.
    sources: [...new Set([...(p.snapshotArtifact?.sizes ?? []).map((sz) => sz.source), ...(p.evidence ?? []), ...p.requirements.map((r) => r.source)].filter(Boolean))].slice(0, 3),
  }));
  const envelope = {
    ...base,
    identityStatus: hardware.identityStatus,
    checkedAt: hardware.checkedAt,
    totalProfiles: hardware.profiles.length,
    totalMatched: profiles.length,
    availableRoles: [...new Set(hardware.profiles.map((p) => p.role))].sort((a, b) => rank(ROLE_ORDER, a) - rank(ROLE_ORDER, b)),
    software,
    note: 'Requirements are quoted in each publisher’s original units — never convert units or do arithmetic across profiles (no sums or averages). A profile that omits a component may take it, verbatim, from a sibling with the same client and scope (another tier of the same role, or the full node for an archive node) — say which profile it came from. A component no profile documents was not documented, never zero. Published requirements, not benchmarks. Cite one `sources` URL (the publisher’s documentation) per quoted profile. observedClients is what live endpoints run, not a requirement. `prerequisiteFor` links this existing profile to another role: relay its condition and notes, and cite its sources for that link. It retains its original role and is not separately sized hardware for the requested role; complete sizing may remain not_established. Never count it twice. A profile with `requiredWhen` is an extra component to run alongside the node in that case (e.g. a legacy client for pre-upgrade history): always mention it for that role; `sizing: not_established` means its hardware is undocumented — say so, and never lend it another client’s numbers. `snapshot` is a download’s size (and link, in <>), not a disk requirement. `dependencies` are other services the returned profiles need, hosted or self-run (`selfHosted` false = a hosted endpoint is fine; `sizing` as for profiles; `notes` qualify it — quote them). verification `unresolved` (sorted last) means the research could not settle the source or its applicability, often because the page could not be re-read: use it only when no confirmed/qualified profile covers the question, and say it is unverified.',
  };
  if (profiles.length === 0) {
    envelope.message = `No ${[role, level].filter(Boolean).join(' ')} profile is documented for this chain, but ${hardware.profiles.length} other profile(s) are (roles: ${envelope.availableRoles.join(', ')}) — call again without the filter.`;
  }
  // The assistant cuts tool results at ASSISTANT_TOOL_RESULT_MAX_CHARS — mid-value, leaving
  // malformed JSON — so the budget is enforced here, by whole profiles, and `truncated`
  // tells the model to narrow by role/level for the rest. `dependencies` follow the profiles
  // that fit, so the response never lists a service for a profile it dropped.
  const respond = (kept) => {
    const dependencies = dependenciesOf(shown.slice(0, kept.length));
    return { ...envelope, ...(dependencies.length && { dependencies }), count: kept.length, truncated: profiles.length > kept.length, profiles: kept };
  };
  return compactResponse(respond(fitWithinBudget(respond, candidates, ASSISTANT_TOOL_RESULT_MAX_CHARS)));
}

/** The longest prefix of `items` whose response, `respond(prefix)`, stays within `budget` characters. */
function fitWithinBudget(respond, items, budget) {
  const kept = [];
  for (const item of items) {
    kept.push(item);
    // Sized as truncated: true, the longer of the two flags.
    if (JSON.stringify({ ...respond(kept), truncated: true }).length > budget) {
      kept.pop();
      break;
    }
  }
  return kept;
}

function handleSearchChains(args) {
  const { query } = args;
  if (!query) {
    return errorResponse('Query is required');
  }
  const results = searchChains(query);
  return textResponse({ query, count: results.length, results });
}

function handleGetEndpoints(args) {
  if (args.chainId === undefined) {
    const endpoints = getAllEndpoints();
    return textResponse({ count: endpoints.length, endpoints });
  }

  const { chainId } = args;
  if (!isValidChainId(chainId)) {
    return errorResponse('Invalid chain ID');
  }
  const result = getEndpointsById(chainId);
  if (!result) {
    return errorResponse('Chain not found');
  }
  return textResponse(result);
}

function handleGetRelations(args) {
  if (args.chainId === undefined) {
    return textResponse(getAllRelations());
  }

  const { chainId } = args;
  if (!isValidChainId(chainId)) {
    return errorResponse('Invalid chain ID');
  }
  const result = getRelationsById(chainId);
  if (!result) {
    return errorResponse('Chain not found');
  }
  return textResponse(result);
}

function handleGetSlip44(args) {
  const cachedData = getCachedData();
  if (!cachedData.slip44) {
    return errorResponse('SLIP-0044 data not loaded');
  }

  if (args.coinType === undefined) {
    return textResponse({
      count: Object.keys(cachedData.slip44).length,
      coinTypes: cachedData.slip44,
    });
  }

  const { coinType } = args;
  if (typeof coinType !== 'number' || Number.isNaN(coinType)) {
    return errorResponse('Invalid coin type');
  }
  const coinTypeData = cachedData.slip44[coinType];
  if (!coinTypeData) {
    return errorResponse('Coin type not found');
  }
  return textResponse(coinTypeData);
}

function handleGetSources() {
  const cachedData = getCachedData();
  return textResponse({
    lastUpdated: cachedData.lastUpdated,
    sources: {
      theGraph: cachedData.theGraph ? 'loaded' : 'not loaded',
      chainlist: cachedData.chainlist ? 'loaded' : 'not loaded',
      chains: cachedData.chains ? 'loaded' : 'not loaded',
      slip44: cachedData.slip44 ? 'loaded' : 'not loaded',
    },
  });
}

function handleGetKeywords() {
  const cachedData = getCachedData();
  const keywordResults = getAllKeywords();

  return textResponse({
    lastUpdated: cachedData.lastUpdated,
    ...keywordResults,
  });
}

function handleValidateChains() {
  const validationResults = validateChainData();
  if (validationResults.error) {
    return errorResponse(validationResults.error);
  }
  return textResponse(validationResults);
}

function handleGetStats() {
  const chains = getAllChains();
  const monitorResults = getRpcMonitoringResults();

  const { totalChains, totalMainnets, totalTestnets, totalL2s, totalBeacons, byStatus, activeChains, deprecatedChains } = countChainsByTag(chains);

  const rpcTested = monitorResults.testedEndpoints;
  const rpcWorking = monitorResults.workingEndpoints;
  const rpcFailed = monitorResults.failedEndpoints || 0;
  const rpcHealthPercent = rpcTested > 0 ? Math.round((rpcWorking / rpcTested) * 10000) / 100 : null;

  return textResponse({
    totalChains,
    totalMainnets,
    totalTestnets,
    totalL2s,
    totalBeacons,
    activeChains,
    deprecatedChains,
    byStatus,
    rpc: {
      totalEndpoints: monitorResults.totalEndpoints,
      tested: rpcTested,
      working: rpcWorking,
      failed: rpcFailed,
      healthPercent: rpcHealthPercent,
    },
    lastUpdated: monitorResults.lastUpdated,
  });
}

function handleTraverseRelations(args) {
  const { chainId, depth } = args;
  if (!isValidChainId(chainId)) {
    return errorResponse('Invalid chain ID');
  }

  const maxDepth = depth ?? 2;
  if (typeof maxDepth !== 'number' || maxDepth < 1 || maxDepth > 5) {
    return errorResponse('Invalid depth. Must be between 1 and 5');
  }

  const result = traverseRelations(chainId, maxDepth);
  if (!result) {
    return errorResponse('Chain not found');
  }
  return textResponse(result);
}

function getStatusLabel(status, results) {
  if (status.isMonitoring) return 'Running';
  if (results.testedEndpoints > 0) return 'Completed';
  return 'Starting up...';
}

function formatRpcMonitorStatus(status, results) {
  const lines = [
    '## RPC Monitoring Status',
    '',
    `**Status:** ${getStatusLabel(status, results)}`,
    `**Last Updated:** ${results.lastUpdated ?? 'N/A'}`,
    '',
    '### Summary',
    `- Total endpoints discovered: ${results.totalEndpoints}`,
    `- Endpoints tested: ${results.testedEndpoints}`,
    `- Working endpoints: ${results.workingEndpoints}`,
    `- Failed endpoints: ${results.failedEndpoints ?? 0}`,
    '- Use `get_rpc_monitor_by_id` for per-chain endpoint details.',
  ];

  if (!status.isMonitoring && results.testedEndpoints === 0) {
    lines.push(
      '',
      '> Monitoring has been started but has not completed a run yet. Check back shortly.',
      '> Use `get_rpc_monitor_by_id` with a chain ID once data is available.'
    );
  } else {
    lines.push('', '> Per-chain endpoint lists are available via `get_rpc_monitor_by_id`.');
  }

  return lines.join('\n');
}

function handleGetRpcMonitor() {
  const results = getRpcMonitoringResults();
  const status = getRpcMonitoringStatus();
  return { content: [{ type: 'text', text: formatRpcMonitorStatus(status, results) }] };
}

async function handleGetRpcMonitorById(args) {
  const { chainId } = args;
  if (!isValidChainId(chainId)) {
    return errorResponse('Invalid chain ID');
  }

  let results = getRpcMonitoringResults();
  let chainResults = results.results.filter((r) => r.chainId === chainId);

  // Post-deploy blind window: the rolling sweep may not have reached this
  // chain yet. Probe its endpoints on demand instead of answering "nothing".
  if (chainResults.length === 0 && (await ensureChainRpcResults(chainId))) {
    results = getRpcMonitoringResults();
    chainResults = results.results.filter((r) => r.chainId === chainId);
  }

  if (chainResults.length === 0) {
    // Still nothing even after the on-demand attempt: the chain is unknown or
    // has no publicly checkable endpoints — it must never read as "the
    // endpoints are down". An earlier message here ("No working RPC endpoints
    // found") made the assistant declare healthy chains unhealthy.
    const registered = getEndpointsById(chainId);
    const rpcCount = registered?.rpc?.length ?? null;
    const message =
      `RPC health status for chain ${chainId} is UNKNOWN: the monitor has no results for this chain` +
      ` and a live on-demand check found no publicly checkable endpoints. This does NOT mean the endpoints are down.` +
      (rpcCount ? ` The registry lists ${rpcCount} RPC endpoint(s) for this chain (see get_endpoints).` : '') +
      ` Do not report this chain as unhealthy based on this result.`;
    return { content: [{ type: 'text', text: message }] };
  }

  const workingCount = chainResults.filter((r) => r.status === 'working').length;
  const lines = [
    `## RPC Monitor — ${chainResults[0].chainName} (chain ${chainId})`,
    '',
    `**Last Updated:** ${results.lastUpdated ?? 'Never'}`,
    `**Working endpoints:** ${workingCount} / ${chainResults.length}`,
    '',
    '### Endpoints',
  ];
  for (const ep of chainResults) {
    const block = ep.blockNumber == null ? '' : ` — block #${ep.blockNumber}`;
    const latency = ep.latencyMs == null ? '' : ` [${ep.latencyMs}ms]`;
    const client = ep.clientVersion && ep.clientVersion !== 'unavailable' ? ` (${ep.clientVersion})` : '';
    lines.push(
      `- **${ep.status}** ${ep.url}${block}${latency}${client}`,
      ...(ep.error ? [`  - Error: ${ep.error}`] : [])
    );
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

async function handleCheckChainHalt(args) {
  const { chainId } = args;
  if (!isValidChainId(chainId)) {
    return errorResponse('Invalid chain ID');
  }
  const result = await checkChainHalt(chainId);
  return textResponse(result);
}

async function handleGetForks(args) {
  try {
    return textResponse(await getForks(args ?? {}));
  } catch (error) {
    // The upstream status feed being unreachable is routine, and every sibling handler says so
    // rather than letting handleToolCall report it as an internal error.
    return errorResponse('Fork timeline unavailable', error.message);
  }
}

// Grouped items shown per event. With full lists Sepolia's Glamsterdam alone was 6 KB; the assistant
// truncates a tool result at 8000 chars, so `counts` carries the totals and these a sample.
const TIMELINE_GROUP_SAMPLE = 2;
const TIMELINE_DEFAULT_LIMIT = 5;
const TIMELINE_MAX_LIMIT = 100;

function withoutNullFields(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null));
}

async function handleGetTimeline(args) {
  const { chainId, type, phase, since, until, limit } = args ?? {};
  const capped = Math.max(1, Math.min(Number(limit) || TIMELINE_DEFAULT_LIMIT, TIMELINE_MAX_LIMIT));
  try {
    const result = await getTimeline({ chainId, type, phase, since, until, limit: capped });
    const sample = (list) => (list ?? []).slice(0, TIMELINE_GROUP_SAMPLE);
    return textResponse({
      ...result,
      // Ids, slugs and source lists are for joining and keying rows, not for reading; nulls
      // say nothing. Each dropped field is ~5% of an entry, and the cap is per character.
      entries: result.entries.map(({ id, networkSlugs, networkNames, sources, feeds, providers, ...e }) => ({
        ...withoutNullFields(e),
        releases: sample(e.releases).map(({ repo, version, mandatory, url, publishedAt }) => ({ repo, version, mandatory, url, publishedAt })),
        providerUpdates: sample(e.providerUpdates).map(({ provider, title, status, activationAt, activationEvidence }) => ({ provider, title, status, activationAt, activationEvidence })),
        news: sample(e.news).map(({ feed, source, title, url, publishedAt }) => ({ feed, source, title, url, publishedAt })),
        followedByIncidents: sample(e.followedByIncidents).map(({ title, url, startedAt, hoursAfterActivation, durationEvidence }) => ({ title, url, startedAt, hoursAfterActivation, durationEvidence }))
      }))
    });
  } catch (error) {
    return errorResponse('Timeline unavailable', error.message);
  }
}

function handleGetClients(args) {
  if (args.chainId === undefined) {
    const results = getRpcMonitoringResults();
    const chains = getClientsByChain();
    return textResponse({
      lastUpdated: results.lastUpdated,
      count: chains.length,
      chains,
    });
  }

  const { chainId } = args;
  if (!isValidChainId(chainId)) {
    return errorResponse('Invalid chain ID');
  }
  const summary = getClientsByChain(chainId);
  if (!summary) {
    return errorResponse('No client data found for this chain');
  }
  return textResponse(summary);
}

// --- Dispatch map ---

function handleGetScalingChains() {
  const chains = getAllChains().filter((c) => c.l2Beat);
  return textResponse({
    count: chains.length,
    refresher: getL2BeatRefreshStatus(),
    chains,
  });
}

function handleGetL2BeatById(args) {
  const { chainId } = args;
  if (!isValidChainId(chainId)) {
    return errorResponse('Invalid chainId', 'chainId must be a positive integer');
  }
  const chain = getChainById(chainId);
  if (!chain) {
    return errorResponse('Not found', `No chain with chainId ${chainId}`);
  }
  if (!chain.l2Beat) {
    return errorResponse('Not found', `Chain ${chainId} (${chain.name}) is not classified by L2BEAT`);
  }
  return textResponse(chain);
}

function handleGetRefresherStatus() {
  return textResponse(getL2BeatRefreshStatus());
}

function handleGetStatusPages() {
  const chains = getAllStatusPages();
  const coins = getAllCoinStatusPages();
  return textResponse({
    chainCount: chains.length,
    coinCount: coins.length,
    statusPages: chains,
    coins,
  });
}

function handleGetStatusPageByChain(args) {
  const { chainId } = args;
  if (!isValidChainId(chainId)) {
    return errorResponse('Invalid chain ID');
  }
  const page = getStatusPageByChainId(chainId);
  if (!page) {
    return errorResponse('No status page found for this chain');
  }
  return textResponse(page);
}

function handleGetStatusPageBySymbol(args) {
  const { symbol } = args;
  if (typeof symbol !== 'string' || symbol.trim() === '') {
    return errorResponse('Symbol is required');
  }
  const page = getStatusPageBySymbol(symbol);
  if (!page) {
    return errorResponse('No status page found for this symbol');
  }
  return textResponse(page);
}

async function handleGetForumNews(args) {
  const { chainId, forum, limit } = args ?? {};
  try {
    const result = await getForumNews({ chainId, forum, limit });
    // publishedMs/freshMs are internal sort/recency keys; drop from tool output
    return textResponse({
      ...result,
      news: result.news.map(({ publishedMs: _publishedMs, freshMs: _freshMs, ...rest }) => rest),
    });
  } catch (error) {
    return errorResponse('Forum news feed unavailable', error.message);
  }
}

async function handleGetChainUpgrades(args) {
  const { chainId, network, limit } = args ?? {};
  try {
    const result = await getChainUpgrades({ chainId, network, limit });
    return textResponse(result);
  } catch (error) {
    return errorResponse('Upgrade timeline unavailable', error.message);
  }
}

async function handleGetProviderStats(args) {
  const { provider } = args ?? {};
  try {
    const result = await getProviderStats({ provider });
    return textResponse(result);
  } catch (error) {
    return errorResponse('Provider stats unavailable', error.message);
  }
}

async function handleGetWeb3News(args) {
  const { chainId, sourceId, weight, limit } = args ?? {};
  try {
    const result = await getWeb3News({ chainId, sourceId, weight, limit });
    // publishedMs is an internal sort key; drop it from tool output.
    return textResponse({
      ...result,
      news: result.news.map(({ publishedMs: _publishedMs, ...rest }) => rest),
    });
  } catch (error) {
    return errorResponse('Web3 news feed unavailable', error.message);
  }
}

const CLIENT_TOOL_DEFAULT_LIMIT = 15;
const CLIENT_TOOL_MAX_LIMIT = 50;
// A free-text client resolves to at most this many registry repositories, each queried exactly.
const CLIENT_TOOL_MAX_REPOS = 5;
const CLIENT_TOOL_WINDOW = 500;
const REPO_ARG = /^((github|gitlab):)?(?!\.+\/)[A-Za-z0-9_.-]+\/(?!\.+$)[A-Za-z0-9_.-]+$/i;

const byNewest = (a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0);
const matchesClient = (needle) => (it) => [it.release.repo, it.source.name, it.source.id, it.title]
  .some((v) => typeof v === 'string' && v.toLowerCase().includes(needle));

/**
 * Releases of the repositories the registry ties to a client name, each fetched by repo — a
 * text match over one global page would miss a client whose latest release is older than the
 * newest 500. Null when the registry knows no repository by that name.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Checks a since/until pair the way the feed reads it: both inclusive, a bare `until` date
 * through the end of that day. `{error}` for a malformed bound or an inverted range.
 */
function releaseRange(since, until) {
  for (const [name, value] of [['since', since], ['until', until]]) {
    if (value != null && (!ISO_DATE.test(String(value)) || !Number.isFinite(Date.parse(value)))) {
      return { error: `${name} must be an ISO date or date-time, e.g. "2026-09-01"` };
    }
  }
  if (since != null && until != null) {
    const end = Date.parse(until) + (/^\d{4}-\d{2}-\d{2}$/.test(String(until)) ? 24 * 60 * 60 * 1000 : 1);
    if (end <= Date.parse(since)) return { error: 'until must not be before since' };
  }
  return {};
}

async function releasesForClient(needle, filters, limit) {
  const registry = await getFeedClients({ q: needle, limit: CLIENT_TOOL_MAX_REPOS + 1 });
  const ids = [...new Set(registry.clients.map((c) => c.id).filter(Boolean))];
  if (!ids.length) return null;
  const pages = await Promise.all(ids.slice(0, CLIENT_TOOL_MAX_REPOS).map((repo) => getClientReleases({ ...filters, repo, limit })));
  const items = pages.flatMap((p) => p.items).sort(byNewest);
  const totals = pages.map((p) => p.totalMatched);
  const reposCut = ids.length > CLIENT_TOOL_MAX_REPOS || registry.truncated === true;
  return {
    fetchedAt: pages.map((p) => p.fetchedAt).sort()[0],
    stale: pages.some((p) => p.stale),
    items,
    // Unknown when a page had no total, or when more repositories matched than were queried.
    totalMatched: !reposCut && totals.every((t) => t != null) ? totals.reduce((a, b) => a + b, 0) : null,
    repos: ids.slice(0, CLIENT_TOOL_MAX_REPOS),
    ...(reposCut && { note: `More than ${CLIENT_TOOL_MAX_REPOS} repositories match "${needle}"; only the first ${CLIENT_TOOL_MAX_REPOS} were searched — pass repo for an exact one.` }),
  };
}

async function handleGetClientReleases(args) {
  const { client, repo, chainId, fork, limit, since, until } = args ?? {};
  if (repo != null && !REPO_ARG.test(String(repo))) {
    return errorResponse('Invalid repo', 'repo must be "owner/repo", "github:owner/repo" or "gitlab:owner/repo"');
  }
  if (chainId != null && !isValidChainId(chainId)) return errorResponse('Invalid chain ID');
  const range = releaseRange(since, until);
  if (range.error) return errorResponse('Invalid date range', range.error);
  const capped = Math.max(1, Math.min(Number(limit) || CLIENT_TOOL_DEFAULT_LIMIT, CLIENT_TOOL_MAX_LIMIT));
  const needle = client ? String(client).toLowerCase().trim() : '';
  const filters = {
    fork: typeof fork === 'boolean' ? fork : undefined,
    chainId: chainId ?? undefined,
    since: since ?? undefined,
    until: until ?? undefined,
  };
  try {
    let result = null;
    let matched;
    // totalMatched null = completeness unknown; never a count passed off as the whole.
    let totalMatched;
    let note;
    if (needle && repo == null) result = await releasesForClient(needle, filters, capped);
    if (result) {
      matched = result.items;
      totalMatched = result.totalMatched;
      note = result.note;
    } else {
      // An exact repo, no filter, or a name the registry does not know: the feed filters what it
      // can and the name is matched over one page, which is complete only if the feed says so.
      result = await getClientReleases({ ...filters, limit: CLIENT_TOOL_WINDOW, repo: repo ?? undefined });
      matched = needle ? result.items.filter(matchesClient(needle)) : result.items;
      const windowComplete = result.truncated === false;
      if (!needle) totalMatched = result.totalMatched ?? (windowComplete ? matched.length : null);
      else if (windowComplete) totalMatched = matched.length;
      else {
        totalMatched = null;
        note = `Matched "${client}" within the newest ${result.items.length} releases only; older ones may exist — pass repo for an exact query.`;
      }
    }
    const releases = matched.slice(0, capped).map((it) => ({
      title: it.title,
      url: it.url,
      publishedAt: it.publishedAt,
      repo: it.release.repo,
      client: it.source.name,
      tag: it.release.tag,
      version: it.release.version,
      prerelease: it.release.prerelease,
      mandatory: it.release.mandatory,
      // null = unknown (no notes, or a feed that predates the field); get_latest_release has the evidence.
      security: it.release.security,
      flagsChanged: it.release.flagsChanged,
      chains: it.chains,
      chainsFrom: it.chainsFrom,
      summary: it.enrichment?.summary ?? null,
      fork: it.enrichment?.fork ?? null,
      ...(it.enrichment?.forks ? { forks: it.enrichment.forks } : {}),
      ...(it.enrichment?.review ? { review: it.enrichment.review } : {}),
    }));
    return compactResponse({
      fetchedAt: result.fetchedAt,
      ...(result.stale ? { stale: true } : {}),
      ...(result.repos ? { repos: result.repos } : {}),
      count: releases.length,
      totalMatched,
      truncated: totalMatched == null ? (matched.length > releases.length || null) : totalMatched > releases.length,
      ...(note ? { note } : {}),
      releases,
    });
  } catch (error) {
    return errorResponse('Client release feed unavailable', error.message);
  }
}

const LATEST_RELEASE_MAX_CHAINS = 10;

async function handleGetLatestRelease(args) {
  const { repo, component, includePrerelease } = args ?? {};
  if (!parseRepo(repo)) {
    return errorResponse('Invalid repo', 'repo must be "owner/repo", "github:owner/repo", "gitlab:owner/repo" or a GitHub/GitLab repository URL');
  }
  if (component != null && !/^[A-Za-z0-9_.@/-]{1,100}$/.test(String(component))) return errorResponse('Invalid component');
  try {
    const out = await getLatestRelease({ repo, component: component ?? undefined, includePrerelease: includePrerelease === true });
    const latest = out.latest;
    if (latest && latest.chains.length > LATEST_RELEASE_MAX_CHAINS) {
      // A repo that serves dozens of networks would spend the result budget on chain names.
      latest.chainsTotal = latest.chains.length;
      latest.chains = latest.chains.slice(0, LATEST_RELEASE_MAX_CHAINS);
    }
    return compactResponse(out);
  } catch (error) {
    if (error instanceof ClientFeedNotFoundError) return errorResponse('No releases found', error.message);
    return errorResponse('Client release feed unavailable', error.message);
  }
}

const ACTIVITY_TOOL_DEFAULT_LIMIT = 3;
const ACTIVITY_TOOL_MAX_LIMIT = 5;

/** `github:owner/repo` / `owner/repo` / `gitlab:owner/repo` -> the feed's lookup parts. */
function repoParts(value) {
  const match = String(value).match(/^(?:(github|gitlab):)?([^/]+)\/(.+)$/i);
  return { host: (match[1] ?? 'github').toLowerCase(), owner: match[2], repo: match[3] };
}

async function handleGetClientActivity(args) {
  const { client, repo, limit } = args ?? {};
  if (repo == null && !(typeof client === 'string' && client.trim())) {
    return errorResponse('repo or client is required', 'Pass repo ("owner/repo") or a client name');
  }
  if (repo != null && !REPO_ARG.test(String(repo))) {
    return errorResponse('Invalid repo', 'repo must be "owner/repo", "github:owner/repo" or "gitlab:owner/repo"');
  }
  const capped = Math.max(1, Math.min(Number(limit) || ACTIVITY_TOOL_DEFAULT_LIMIT, ACTIVITY_TOOL_MAX_LIMIT));
  try {
    let ids;
    let more = false;
    if (repo != null) {
      const { host, owner, repo: name } = repoParts(repo);
      ids = [`${host}:${owner}/${name}`];
    } else {
      // Name-only clients (`name:…`) have no repository to measure.
      const registry = await getFeedClients({ q: client.trim(), limit: capped + 5 });
      const withRepo = registry.clients.filter((c) => c.id && !c.id.startsWith('name:'));
      ids = withRepo.slice(0, capped).map((c) => c.id);
      more = withRepo.length > capped || registry.truncated === true;
    }
    const found = await Promise.all(ids.map(async (id) => {
      const { host, owner, repo: name } = repoParts(id);
      try {
        return (await getFeedClient(host, owner, name)).client;
      } catch (error) {
        if (error instanceof ClientFeedNotFoundError) return null;
        throw error;
      }
    }));
    const clients = found.filter(Boolean).map((c) => ({
      id: c.id,
      repo: c.repo,
      url: c.url,
      names: c.names,
      kinds: c.kinds,
      role: c.role,
      networkCount: c.networkCount,
      latestRelease: c.latestRelease,
      activity: c.activity,
      // Compact: the upstream it customizes, and how many clients customize it (first ten named).
      lineage: c.lineage ? {
        family: c.lineage.family,
        upstream: c.lineage.upstream,
        // networks is a sample (at most ten); networkCount is how many the client serves.
        customizedBy: c.lineage.downstream.slice(0, 10).map((d) => ({ repo: d.repo, via: d.via, networkCount: d.networkCount, networks: d.networks.map((n) => n.name || n.chainId) })),
        customizedByTotal: c.lineage.downstreamTotal,
      } : null,
    }));
    return compactResponse({
      count: clients.length,
      ...(more ? { note: `More repositories match "${client}"; showing ${clients.length} — pass repo for a specific one.` } : {}),
      ...(clients.length === 0 ? { message: repo != null ? `${ids[0]} is not in the client registry.` : `No client repository matches "${client}".` } : {}),
      clients,
    });
  } catch (error) {
    return errorResponse('Client release feed unavailable', error.message);
  }
}

async function handleGetNetworkClients(args) {
  const { chainId } = args ?? {};
  if (!isValidChainId(chainId)) return errorResponse('Invalid chain ID');
  try {
    return compactResponse(await getNetworkClients(chainId));
  } catch (error) {
    return errorResponse('Client release feed unavailable', error.message);
  }
}

async function handleGetLiveIncidents(args) {
  const { type, chainId, provider, ongoing, status, limit } = args ?? {};
  try {
    const result = await getLiveIncidents({ type, chainId, provider, ongoing, status, limit });
    // publishedMs is an internal sort key; drop it from tool output
    return textResponse({
      ...result,
      incidents: result.incidents.map(({ publishedMs: _publishedMs, ...rest }) => rest),
    });
  } catch (error) {
    return errorResponse('Live incident feed unavailable', error.message);
  }
}

const toolHandlers = {
  get_chains: handleGetChains,
  get_chain_by_id: handleGetChainById,
  get_node_requirements: handleGetNodeRequirements,
  search_chains: handleSearchChains,
  get_endpoints: handleGetEndpoints,
  get_relations: handleGetRelations,
  get_slip44: handleGetSlip44,
  get_sources: handleGetSources,
  get_keywords: handleGetKeywords,
  validate_chains: handleValidateChains,
  get_stats: handleGetStats,
  traverse_relations: handleTraverseRelations,
  get_rpc_monitor: handleGetRpcMonitor,
  get_rpc_monitor_by_id: handleGetRpcMonitorById,
  check_chain_halt: handleCheckChainHalt,
  get_scaling_chains: handleGetScalingChains,
  get_l2beat_by_id: handleGetL2BeatById,
  get_refresher_status: handleGetRefresherStatus,
  get_clients: handleGetClients,
  get_status_pages: handleGetStatusPages,
  get_status_page_by_chain: handleGetStatusPageByChain,
  get_status_page_by_symbol: handleGetStatusPageBySymbol,
  get_live_incidents: handleGetLiveIncidents,
  get_forum_news: handleGetForumNews,
  get_web3_news: handleGetWeb3News,
  get_client_releases: handleGetClientReleases,
  get_latest_release: handleGetLatestRelease,
  get_network_clients: handleGetNetworkClients,
  get_client_activity: handleGetClientActivity,
  get_chain_upgrades: handleGetChainUpgrades,
  get_forks: handleGetForks,
  get_timeline: handleGetTimeline,
  get_provider_stats: handleGetProviderStats,
};

/**
 * Handle an MCP tool call by name and arguments
 * @param {string} name - Tool name
 * @param {Object} args - Tool arguments
 * @returns {Promise<Object>} MCP response with content array
 */
export async function handleToolCall(name, args) {
  try {
    // Own-property lookup only: a bare toolHandlers[name] reaches the
    // prototype chain, so a caller asking for "constructor" got Object
    // invoked as the handler (returning its args as the response) instead
    // of an unknown-tool error.
    const handler = Object.hasOwn(toolHandlers, name) ? toolHandlers[name] : null;
    if (!handler) {
      return errorResponse(`Unknown tool: ${name}`);
    }
    return await handler(args);
  } catch (error) {
    return errorResponse('Internal error', error.message);
  }
}

