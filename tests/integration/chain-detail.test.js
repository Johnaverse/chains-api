import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import Ajv from 'ajv';
import { buildApp } from '../../index.js';
import { cachedData } from '../../src/store/cache.js';
import { getChainDetail, _resetGetAllChainsCacheForTests } from '../../src/store/queries.js';
import { _setNetworkResearchForTests, loadNodeHardware } from '../../src/sources/networkResearch.js';

const { quote } = vi.hoisted(() => ({ quote: {
  usd: 10.25, vol24h: null, marketCap: null, asOf: null, stale: false,
  updatedAt: '2026-10-16T00:00:00Z', optionalQuoteData: { retained: true }
} }));
vi.mock('../../priceService.js', () => ({
  getPriceForChain: vi.fn(async id => id === 8453 ? quote : null),
  getPricesForChains: vi.fn(async ids => new Map(ids.map(id => [id, id === 8453 ? quote : null]))),
  prefetchAllPrices: vi.fn(), startPriceRefresh: vi.fn()
}));

const checkedAt = '2026-10-16T00:00:00Z';
const source = 'https://docs.example.org/node';
const extra = { nested: [true, 42, 'raw', null, { value: false }] };
const claim = { status: 'partial', audit: 'qualified', evidence: [source], optionalClaimData: extra };
const profile = {
  id: 'full-minimum', role: 'full_node', level: 'minimum', scope: 'project_family',
  client: null, clientVersion: null, deployment: 'current', verification: 'unresolved',
  notes: null, verificationNotes: 'Applicability unresolved.', evidence: [source],
  requirements: [
    { component: 'memory', metric: 'capacity', value: 16, unit: 'GiB', qualifier: 'at_least', source, optionalRequirementData: extra },
    { component: 'storage', metric: 'capacity', value: null, min: 2, max: 4, unit: 'TB', qualifier: 'range', source },
    { component: 'storage', metric: 'storage_type', value: 'NVMe', unit: null, qualifier: 'as_stated', source },
    { component: 'cpu', metric: 'feature', value: false, unit: null, qualifier: 'as_stated', source },
    { component: 'network', metric: 'bandwidth', value: 25.5, unit: 'Mbps', qualifier: 'as_stated', source }
  ],
  prerequisiteFor: [{ role: 'validator', requiredWhen: 'Run a validator', sizing: 'not_established', notes: null, sources: [source], optionalPrerequisiteData: extra }],
  dependencies: [{ component: 'L1 RPC', requiredWhen: 'Sync', selfHosted: false, clientOptions: ['geth'], sizing: 'not_established', sources: [source], optionalDependencyData: extra }],
  snapshotArtifact: { type: 'download', file: 'chain.tar.zst', sizes: [{ value: 1.5, unit: 'TiB', source, optionalSizeData: extra }], optionalSnapshotData: extra },
  optionalProfileData: extra
};
const researchEntry = {
  chainId: 8453, family: 'OP Stack', coverage: 'partial', auditStatus: 'qualified', checkedAt,
  websiteCorrection: null,
  repositories: [{ url: 'https://github.com/example/node', repo: 'example/node', kind: 'node', kindLabel: 'Node', ...claim }],
  papers: [{ url: source, title: 'Protocol', ...claim }],
  features: [{ text: 'Published claim', ...claim }], optionalResearchData: extra
};
const channel = {
  platform: 'email', url: 'mailto:help@example.org', canonicalUrl: null, title: 'Support', mode: 'support',
  audience: ['developers'], relationship: 'official_operated', scope: 'exact_network', access: 'not_checked',
  invitation: 'not_applicable', verification: 'qualified', lastActivity: null, evidence: [source],
  alternateInvites: [], activity: 'historical_activity_observed', checkedAt, evidenceMode: 'saved_capture',
  current_availability_checks: [{ status: 'accessible_public_content', activity_status: 'inactive', observed_title: null, latest_observed_activity: null, evidence_urls: [source], ...extra }],
  independent_verification: { status: 'qualified', checked_at_utc: checkedAt, source_urls: [source], ...extra }, optionalChannelData: extra
};
const hardwareEntries = [
  { chainId: 8453, name: 'Base', status: 'documented', identityStatus: 'qualified', checkedAt, notes: 'Static sizing', sources: [{ url: source, title: null, access: 'read', optionalSourceData: extra }], profiles: [profile, { ...profile, id: 'legacy', role: 'archive', requiredWhen: 'Pre-upgrade state', sizing: 'not_established', historicalStateEra: 'legacy', requirements: [] }], optionalHardwareData: extra },
  { chainId: 777, name: 'No Profile', status: 'not_found', identityStatus: 'unresolved', checkedAt: null, notes: 'No published requirements found.', sources: [{ url: source, title: 'Docs', access: 'inaccessible' }], profiles: [] }
];
const richChain = {
  chainId: 8453, name: 'Base', shortName: null,
  theGraph: { id: 'base', fullName: 'Base Mainnet', caip2Id: 'eip155:8453', aliases: ['base-mainnet'] },
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18, extraCurrencyData: extra },
  explorers: ['https://explorer.example.org', { name: 'Explorer', url: source, standard: null, extraExplorerData: extra }],
  bridges: [source, { url: source, extraBridgeData: extra }],
  infoURL: source, infoURLSource: 'research', registryInfoURL: null, family: 'OP Stack',
  sources: ['chains', 'research'], tags: ['L2'], status: 'active', statusReason: 'Registry', forumUrl: source,
  l2Beat: { slug: 'base', stage: null, tvs: 0, activity: null, hostChainId: null, riskView: [{ value: 'High' }], extraScalingData: extra },
  defillama: { name: 'Base', website: null, parent: null, deprecated: false, extraDefiData: extra }
};

function seedChains(chains) {
  cachedData.indexed = { byChainId: Object.fromEntries(chains.map(c => [c.chainId, c])), all: chains };
  _resetGetAllChainsCacheForTests();
}

// Real Fastify + real store/research projection; only the external price fetch is stubbed.
// A schema-presence test alone cannot catch fast-json-stringify dropping nested data.
describe('chain detail response contract and serialization', () => {
  let app;
  let dir;
  let paths;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'chains-detail-'));
    const datasets = [
      [researchEntry],
      [{ chainId: 8453, checkedAt, forums: [{ url: source, title: 'Forum', type: 'developer', relationship: 'official', scope: 'project_family', access: 'archived', activity: 'historical_or_archived', lastActivity: null, verification: 'qualified', notes: null, evidence: [source], optionalForumData: extra }] }],
      hardwareEntries,
      [{ chainId: 8453, checkedAt, channels: [channel] }]
    ];
    paths = datasets.map((networks, index) => {
      const path = join(dir, `${index}.json`);
      writeFileSync(path, JSON.stringify({ updatedAt: checkedAt, networks }));
      return path;
    });
    app = await buildApp({ logger: false, loadDataOnStartup: false });
    await app.ready();
  });
  beforeEach(() => {
    _setNetworkResearchForTests(...paths);
    seedChains([richChain, { chainId: 777, name: 'No Profile' }, { chainId: 999, name: 'Unresearched' }]);
  });
  afterAll(async () => {
    await app.close();
    _setNetworkResearchForTests();
    cachedData.indexed = null;
    _resetGetAllChainsCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it('preserves the complete projected detail, all research types, optional raw metadata and price', async () => {
    const response = await app.inject('/chains/8453');
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual(JSON.parse(JSON.stringify({ ...getChainDetail(8453), price: quote })));
    expect(body.research.repositories).toEqual(researchEntry.repositories);
    expect(body.research.papers).toEqual(researchEntry.papers);
    expect(body.research.features).toEqual(researchEntry.features);
    expect(body.research.channels).toEqual([channel]);
    expect(body.research.hardware.profiles).toEqual(hardwareEntries[0].profiles);
    expect(body.research.hardware.optionalHardwareData).toEqual(extra);
    expect(body.research.hardware.sources).toEqual(hardwareEntries[0].sources);
    expect(body).not.toHaveProperty('rpc');
    expect(body).not.toHaveProperty('relations');
  });

  it('includes status, notes and checked sources for a researched chain with no hardware profile', async () => {
    const response = await app.inject('/chains/777');
    expect(response.statusCode).toBe(200);
    expect(response.json().research).toEqual({
      hardware: { status: 'not_found', identityStatus: 'unresolved', checkedAt, notes: hardwareEntries[1].notes, sources: hardwareEntries[1].sources, profiles: [] },
      updatedAt: checkedAt
    });
    expect(response.json().price).toBeNull();
  });

  it('omits research for an unresearched chain and retains a null price', async () => {
    const response = await app.inject('/chains/999');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ chainId: 999, name: 'Unresearched', price: null });
  });

  it('keeps list and search projections free of research', async () => {
    const list = (await app.inject('/chains')).json();
    expect(list.count).toBe(3);
    expect(list.chains.every(chain => !Object.hasOwn(chain, 'research'))).toBe(true);
    expect(list.chains.find(chain => chain.chainId === 8453).price).toEqual(quote);
    const search = (await app.inject('/search?q=base')).json();
    expect(search.count).toBe(1);
    expect(search.results[0]).not.toHaveProperty('research');
    expect(search.results[0]).not.toHaveProperty('price');
  });

  it('documents the actual success, invalid-ID and not-found response shapes', async () => {
    const spec = (await app.inject('/openapi.json')).json();
    const responses = spec.paths['/chains/{id}'].get.responses;
    const schema = responses['200'].content['application/json'].schema;
    expect(schema.required).toEqual(['chainId', 'price']);
    expect(schema.properties.price.type).toContain('null');
    expect(schema.properties.research.properties.hardware.properties.profiles.items.properties.prerequisiteFor).toBeDefined();
    expect(schema.properties.research.properties.channels.items.properties.current_availability_checks).toBeDefined();
    const validate = new Ajv({ strict: false }).compile(schema);
    for (const id of [8453, 777, 999]) {
      const body = (await app.inject(`/chains/${id}`)).json();
      expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
    }
    for (const [id, status, error] of [['bad-id', 400, 'Invalid chain ID'], ['424242', 404, 'Chain not found']]) {
      const response = await app.inject(`/chains/${id}`);
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ error });
      expect(responses[status].content['application/json'].schema.required).toEqual(['error']);
    }
  });

  it.each([10, 42161, 42220, 2])('round-trips checked-in research for chain %i without serializer losses', async chainId => {
    _setNetworkResearchForTests();
    seedChains([{ chainId, name: `Chain ${chainId}` }]);
    const response = await app.inject(`/chains/${chainId}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...getChainDetail(chainId), price: null });
    const raw = loadNodeHardware().byChainId.get(chainId);
    expect(response.json().research.hardware).toMatchObject({
      status: raw.status, profiles: raw.profiles, sources: raw.sources ?? [], notes: raw.notes ?? null
    });
  });
});
