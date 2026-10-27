import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../config.js', async (importOriginal) => ({ ...(await importOriginal()), CLIENT_FEED_URL: 'https://clients.test', CLIENT_FEED_FETCH_TIMEOUT_MS: 1000 }));
vi.mock('../../../src/sources/feedHttp.js', () => ({ getFeed: vi.fn() }));

import { getFeed } from '../../../src/sources/feedHttp.js';
import { requestForkSources, forkSourceOf, forkSourceVersion, _resetForkSourcesForTests } from '../../../src/sources/forkSource.js';
import { nodeForkMentions, _setNodeForkScheduleForTests, _resetNodeForkSchedulesForTests } from '../../../src/sources/nodeForkSchedule.js';

const NOW = Date.parse('2026-10-27T12:00:00Z');
const reply = (items) => ({ ok: true, json: async () => ({ items }) });
const jenner = {
  chainId: 97, time: 1793241000, status: 'found', name: 'Jenner', repo: 'bnb-chain/bsc', path: 'params/config.go',
  url: 'https://github.com/bnb-chain/bsc/blob/HEAD/params/config.go',
  forks: [{ name: 'Pasteur', activationTime: 1784601000, activationBlock: null }, { name: 'Jenner', activationTime: 1793241000, activationBlock: null }]
};

beforeEach(() => {
  _resetForkSourcesForTests();
  _resetNodeForkSchedulesForTests();
  getFeed.mockReset();
});

describe('fork names from client code (chains-client-feed /fork-source)', () => {
  it('asks the feed for each pair once and keeps what it found', async () => {
    getFeed.mockResolvedValueOnce(reply([jenner, { chainId: 56, time: 1787625000, status: 'pending' }]));
    await requestForkSources([{ chainId: 97, time: 1793241000 }, { chainId: 56, time: 1787625000 }, { chainId: 97, time: 1793241000 }], { now: NOW });
    expect(getFeed.mock.calls[0][0]).toBe('https://clients.test/fork-source?at=97:1793241000,56:1787625000');
    expect(forkSourceOf(97, 1793241000)).toMatchObject({ name: 'Jenner', repo: 'bnb-chain/bsc', forks: [{ name: 'Pasteur' }, { name: 'Jenner' }] });
    expect(forkSourceOf(56, 1787625000)).toBeNull();
    expect(forkSourceVersion()).toBe(1);
    // Found is kept; pending waits before it is asked again.
    expect(requestForkSources([{ chainId: 97, time: 1793241000 }, { chainId: 56, time: 1787625000 }], { now: NOW + 60_000 })).toBeNull();
    getFeed.mockResolvedValueOnce(reply([]));
    await requestForkSources([{ chainId: 56, time: 1787625000 }], { now: NOW + 6 * 60_000 });
    expect(getFeed.mock.calls[1][0]).toBe('https://clients.test/fork-source?at=56:1787625000');
  });

  it('asks again for a found answer each period: the schedule follows the code, a failed re-ask keeps it', async () => {
    getFeed.mockResolvedValueOnce(reply([jenner]));
    await requestForkSources([{ chainId: 97, time: 1793241000 }], { now: NOW });
    const v = forkSourceVersion();
    // The feed re-read bsc's params/config.go: a fork scheduled since.
    const kepler = { ...jenner, forks: [...jenner.forks, { name: 'Kepler', activationTime: 1796000000, activationBlock: null }] };
    getFeed.mockResolvedValueOnce(reply([kepler]));
    await requestForkSources([{ chainId: 97, time: 1793241000 }], { now: NOW + 61 * 60_000 });
    expect(forkSourceOf(97, 1793241000).forks.map((f) => f.name)).toEqual(['Pasteur', 'Jenner', 'Kepler']);
    expect(forkSourceVersion()).toBe(v + 1);
    getFeed.mockRejectedValueOnce(new Error('down'));
    await requestForkSources([{ chainId: 97, time: 1793241000 }], { now: NOW + 122 * 60_000 });
    expect(forkSourceOf(97, 1793241000)).toMatchObject({ name: 'Jenner' });
    // …and waits a full period before asking again.
    expect(requestForkSources([{ chainId: 97, time: 1793241000 }], { now: NOW + 123 * 60_000 })).toBeNull();
  });

  it('backs off after a failed attempt, retries included', async () => {
    getFeed.mockRejectedValue(new Error('down'));
    await requestForkSources([{ chainId: 97, time: 1793241000 }], { now: NOW });
    expect(requestForkSources([{ chainId: 97, time: 1793241000 }], { now: NOW + 60_000 })).toBeNull();
    await requestForkSources([{ chainId: 97, time: 1793241000 }], { now: NOW + 31 * 60_000 });
    // The retry failed too: it waits again from ITS time, not from the first attempt.
    expect(requestForkSources([{ chainId: 97, time: 1793241000 }], { now: NOW + 32 * 60_000 })).toBeNull();
    expect(getFeed).toHaveBeenCalledTimes(2);
  });

  it('drops malformed answers', async () => {
    getFeed.mockResolvedValueOnce(reply([{ ...jenner, name: '<script>' }, { chainId: 1, time: 1767747671, status: 'found', name: 'BPO2', url: 'http://evil', forks: [{ name: 'BPO2', activationTime: 1e20 }] }]));
    await requestForkSources([{ chainId: 97, time: 1793241000 }, { chainId: 1, time: 1767747671 }], { now: NOW });
    expect(forkSourceOf(97, 1793241000)).toBeNull();
    expect(forkSourceOf(1, 1767747671)).toMatchObject({ name: 'BPO2', url: null, forks: [] });
  });

  it('names the node fork and adds the chain\'s schedule from its client code', async () => {
    getFeed.mockResolvedValueOnce(reply([jenner]));
    await requestForkSources([{ chainId: 97, time: 1793241000 }], { now: NOW });
    _setNodeForkScheduleForTests(97, { checkedAt: NOW, url: 'https://rpc', current: { activationTime: 1784601000, forkId: '0x5203e674' }, next: { activationTime: 1793241000, forkId: '0xe660a57e' }, last: null, nextSince: NOW });
    const mentions = nodeForkMentions({ now: NOW, sourceOf: forkSourceOf });
    const node = mentions.filter((m) => m.feed === 'node');
    expect(node.map((m) => m.enrichment.fork.name)).toEqual([null, 'Jenner']);
    const source = mentions.filter((m) => m.feed === 'source');
    expect(source.map((m) => [m.enrichment.fork.name, m.enrichment.fork.activationAt, m.enrichment.fork.state, m.enrichment.fork.chainIds])).toEqual([
      ['Pasteur', '2026-07-21T02:30:00.000Z', 'completed', [97]],
      ['Jenner', '2026-10-29T02:30:00.000Z', 'scheduled', [97]]
    ]);
    expect(source[0]).toMatchObject({ url: jenner.url, statusPage: { id: 'source:bnb-chain/bsc', kind: 'source' } });
  });
});
