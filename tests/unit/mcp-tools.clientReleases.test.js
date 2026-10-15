import { describe, it, expect, vi, beforeEach } from 'vitest';

const feed = vi.hoisted(() => ({ getClientReleases: vi.fn(), getFeedClients: vi.fn(), getNetworkClients: vi.fn() }));
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
  beforeEach(() => {
    vi.clearAllMocks();
    feed.getFeedClients.mockResolvedValue({ clients: [], totalMatched: 0, truncated: false });
  });

  it('get_client_releases resolves a client name to its repositories and queries each exactly', async () => {
    // Lighthouse's release is older than the newest 500 overall; per-repo queries still find it.
    feed.getFeedClients.mockResolvedValue({ clients: [{ id: 'github:sigp/lighthouse' }], totalMatched: 1, truncated: false });
    feed.getClientReleases.mockResolvedValue({ fetchedAt: 'now', stale: false, totalMatched: 7, truncated: true, count: 5, items: [rel('sigp/lighthouse', 'lighthouse')] });
    const out = parse(await handleToolCall('get_client_releases', { client: 'LIGHT', chainId: 1, fork: true, limit: 5 }));
    expect(feed.getFeedClients).toHaveBeenCalledWith({ q: 'light', limit: 6 });
    expect(feed.getClientReleases).toHaveBeenCalledWith({ fork: true, chainId: 1, repo: 'github:sigp/lighthouse', limit: 5 });
    expect(out).toMatchObject({ repos: ['github:sigp/lighthouse'], count: 1, totalMatched: 7, truncated: true });
    expect(out.releases[0]).toMatchObject({ repo: 'sigp/lighthouse', fork: { name: 'Fusaka' }, summary: 's' });
  });

  it('get_client_releases falls back to one page for an unknown name, and says when that page is partial', async () => {
    const items = [rel('ethereum/go-ethereum', 'go-ethereum'), rel('sigp/lighthouse', 'lighthouse')];
    feed.getClientReleases.mockResolvedValue({ fetchedAt: 'now', totalMatched: 900, truncated: true, count: 2, items });
    let out = parse(await handleToolCall('get_client_releases', { client: 'light' }));
    expect(feed.getClientReleases).toHaveBeenCalledWith({ fork: undefined, chainId: undefined, limit: 500, repo: undefined });
    expect(out).toMatchObject({ count: 1, totalMatched: null, truncated: null });
    expect(out.note).toMatch(/newest 2 releases only/);

    feed.getClientReleases.mockResolvedValue({ fetchedAt: 'now', totalMatched: 2, truncated: false, count: 2, items });
    out = parse(await handleToolCall('get_client_releases', { client: 'light' }));
    expect(out).toMatchObject({ count: 1, totalMatched: 1, truncated: false });
    expect(out).not.toHaveProperty('note');
  });

  it('get_client_releases caps output, keeps the feed total, and accepts GitLab repos', async () => {
    feed.getClientReleases.mockResolvedValue({ fetchedAt: 'now', totalMatched: 800, truncated: true, count: 60, items: Array.from({ length: 60 }, (_, i) => rel(`o/r${i}`, `r${i}`)) });
    expect(parse(await handleToolCall('get_client_releases', {}))).toMatchObject({ count: 15, totalMatched: 800, truncated: true });
    // A legacy feed without totals: completeness is unknown, not invented.
    feed.getClientReleases.mockResolvedValue({ fetchedAt: 'now', totalMatched: null, truncated: null, count: 3, items: [rel('o/a', 'a')] });
    expect(parse(await handleToolCall('get_client_releases', {}))).toMatchObject({ count: 1, totalMatched: null, truncated: null });

    await handleToolCall('get_client_releases', { repo: 'gitlab:tezos/tezos' });
    expect(feed.getClientReleases).toHaveBeenLastCalledWith(expect.objectContaining({ repo: 'gitlab:tezos/tezos' }));
    expect((await handleToolCall('get_client_releases', { repo: '../x' })).isError).toBe(true);
    expect((await handleToolCall('get_client_releases', { repo: 'bitbucket:o/r' })).isError).toBe(true);
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
