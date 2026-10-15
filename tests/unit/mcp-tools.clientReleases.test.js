import { describe, it, expect, vi, beforeEach } from 'vitest';

const feed = vi.hoisted(() => ({ getClientReleases: vi.fn(), getNetworkClients: vi.fn() }));
vi.mock('../../src/sources/clientFeed.js', () => feed);

const { handleToolCall } = await import('../../mcp-tools.js');

const rel = (repo, name, over = {}) => ({
  id: `${repo}@v1`, title: `${name} v1`, url: `https://github.com/${repo}/releases/tag/v1`, publishedAt: '2025-11-04T10:00:00Z',
  source: { id: `github:${repo}`, name, kind: 'client-release' }, chains: [{ chainId: 1, name: 'Ethereum' }], chainsFrom: 'release',
  release: { repo, tag: 'v1', version: '1', prerelease: false, mandatory: false },
  enrichment: { class: 'planned_hard_fork', createdAt: null, summary: 's', fork: { name: 'Fusaka', network: 'Ethereum', activationAt: null, activationBlock: null, state: 'scheduled' } },
  ...over
});
const parse = (r) => JSON.parse(r.content[0].text);

describe('client release MCP tools', () => {
  beforeEach(() => vi.clearAllMocks());

  it('get_client_releases passes feed filters and matches client text locally', async () => {
    feed.getClientReleases.mockResolvedValue({
      fetchedAt: 'now', stale: false, count: 2,
      items: [rel('ethereum/go-ethereum', 'go-ethereum'), rel('sigp/lighthouse', 'lighthouse')]
    });
    const out = parse(await handleToolCall('get_client_releases', { client: 'LIGHT', chainId: 1, fork: true, limit: 5 }));
    expect(feed.getClientReleases).toHaveBeenCalledWith({ limit: 500, fork: true, chainId: 1, repo: undefined });
    expect(out).toMatchObject({ count: 1, totalMatched: 1, truncated: false });
    expect(out.releases[0]).toMatchObject({ repo: 'sigp/lighthouse', fork: { name: 'Fusaka' }, summary: 's' });
  });

  it('get_client_releases caps output and rejects a malformed repo', async () => {
    feed.getClientReleases.mockResolvedValue({ fetchedAt: 'now', count: 60, items: Array.from({ length: 60 }, (_, i) => rel(`o/r${i}`, `r${i}`)) });
    const out = parse(await handleToolCall('get_client_releases', {}));
    expect(out).toMatchObject({ count: 15, totalMatched: 60, truncated: true });
    const bad = await handleToolCall('get_client_releases', { repo: '../x' });
    expect(bad.isError).toBe(true);
  });

  it('reports the feed error instead of throwing', async () => {
    feed.getClientReleases.mockRejectedValue(new Error('Client release feed not configured'));
    const res = await handleToolCall('get_client_releases', {});
    expect(res.isError).toBe(true);
    expect(parse(res).message).toBe('Client release feed not configured');
  });

  it('get_network_clients requires a chain id and relays the list', async () => {
    expect((await handleToolCall('get_network_clients', {})).isError).toBe(true);
    feed.getNetworkClients.mockResolvedValue({ chainId: 1, count: 1, clients: [{ repo: 'ethereum/go-ethereum' }] });
    const out = parse(await handleToolCall('get_network_clients', { chainId: 1 }));
    expect(feed.getNetworkClients).toHaveBeenCalledWith(1);
    expect(out.clients[0].repo).toBe('ethereum/go-ethereum');
  });
});
