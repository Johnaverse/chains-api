import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../rpcUtil.js', () => ({ jsonRpcCall: vi.fn() }));

import { jsonRpcCall } from '../../../rpcUtil.js';
import {
  parseEthConfig, refreshNodeForkSchedule, nodeForkMentions, nodeForkScheduleVersion, _resetNodeForkSchedulesForTests
} from '../../../src/sources/nodeForkSchedule.js';

// BSC Chapel's answer on 2026-10-27: Pasteur active, Jenner (0xe660a57e) scheduled.
const chapel = {
  current: { activationTime: 1784601000, chainId: '0x61', forkId: '0x5203E674' },
  next: { activationTime: 1793241000, chainId: '0x61', forkId: '0xe660a57e' },
  last: { activationTime: 1793241000, chainId: '0x61', forkId: '0xe660a57e' }
};
const NOW = Date.parse('2026-10-27T12:00:00Z');

beforeEach(() => {
  _resetNodeForkSchedulesForTests();
  jsonRpcCall.mockReset();
});

describe('node fork schedule (eth_config)', () => {
  it('reads current, next and last, and only for the chain asked', () => {
    expect(parseEthConfig(chapel, 97)).toEqual({
      current: { activationTime: 1784601000, forkId: '0x5203e674' },
      next: { activationTime: 1793241000, forkId: '0xe660a57e' },
      last: { activationTime: 1793241000, forkId: '0xe660a57e' }
    });
    // An endpoint listed for 56 that answers for 97 is not 56's schedule.
    expect(parseEthConfig(chapel, 56)).toBeNull();
    expect(parseEthConfig({ current: null }, 97)).toBeNull();
    expect(parseEthConfig({ ...chapel, next: null, last: null }, 97).next).toBeNull();
    // A safe integer no Date can hold is not a time.
    expect(parseEthConfig({ ...chapel, next: { ...chapel.next, activationTime: 8640000000001 } }, 97).next).toBeNull();
  });

  it('tries working endpoints until one answers, then waits for the refresh interval', async () => {
    jsonRpcCall.mockRejectedValueOnce(new Error('method not found')).mockResolvedValueOnce(chapel);
    const entry = await refreshNodeForkSchedule(97, ['https://a', 'https://b'], { now: NOW });
    expect(entry).toMatchObject({ url: 'https://b', next: { forkId: '0xe660a57e' } });
    expect(jsonRpcCall).toHaveBeenCalledWith('https://a', 'eth_config', expect.any(Object));
    const version = nodeForkScheduleVersion();
    await refreshNodeForkSchedule(97, ['https://b'], { now: NOW + 60_000 });
    expect(jsonRpcCall).toHaveBeenCalledTimes(2);
    expect(nodeForkScheduleVersion()).toBe(version);
  });

  it('marks a chain none of whose endpoints answer, and keeps a schedule read before', async () => {
    jsonRpcCall.mockRejectedValue(new Error('method not found'));
    expect(await refreshNodeForkSchedule(1, ['https://a'], { now: NOW })).toMatchObject({ unsupported: true });
    jsonRpcCall.mockReset().mockResolvedValueOnce(chapel);
    await refreshNodeForkSchedule(97, ['https://b'], { now: NOW });
    jsonRpcCall.mockReset().mockRejectedValue(new Error('down'));
    const later = await refreshNodeForkSchedule(97, ['https://b'], { now: NOW + 7 * 3600_000 });
    expect(later).toMatchObject({ next: { forkId: '0xe660a57e' } });
    expect(later.unsupported).toBeUndefined();
  });

  it('serves each distinct fork as a dated mention on its chain', async () => {
    jsonRpcCall.mockResolvedValueOnce(chapel);
    await refreshNodeForkSchedule(97, ['https://b'], { now: NOW });
    const mentions = nodeForkMentions({ now: NOW, nameOf: () => 'BNB Smart Chain Testnet' });
    // next and last are one fork.
    expect(mentions.map((m) => [m.enrichment.fork.activationAt, m.enrichment.fork.state, m.enrichment.fork.forkId])).toEqual([
      ['2026-07-21T02:30:00.000Z', 'completed', '0x5203e674'],
      ['2026-10-29T02:30:00.000Z', 'scheduled', '0xe660a57e']
    ]);
    expect(mentions[1]).toMatchObject({ feed: 'node', chains: [{ chainId: 97 }], id: 'node:97:0xe660a57e:1793241000', enrichment: { class: 'planned_hard_fork', fork: { name: null } } });
    expect(mentions[1].title).toContain('BNB Smart Chain Testnet');
  });

  it('leaves out a fork parked far ahead: a placeholder, not a schedule', async () => {
    // LUKSO's nodes report next at 2050-01-01.
    jsonRpcCall.mockResolvedValueOnce({ ...chapel, next: { ...chapel.next, activationTime: 2524608000 }, last: { ...chapel.last, activationTime: 2524608000 } });
    await refreshNodeForkSchedule(97, ['https://b'], { now: NOW });
    expect(nodeForkMentions({ now: NOW }).map((m) => m.enrichment.fork.activationAt)).toEqual(['2026-07-21T02:30:00.000Z']);
  });
});
