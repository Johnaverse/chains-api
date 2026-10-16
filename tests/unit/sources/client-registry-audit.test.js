import { describe, it, expect } from 'vitest';
import { getNetworkResearch, getRepositoryInputs, loadClientRegistryOverrides } from '../../../src/sources/networkResearch.js';

const es = 'github:ethstorage/es-node';
const nvnm = 'github:nvnm-chain/nvnmchain';
const repository = (id, repo) => getNetworkResearch(id).repositories.find(r => r.repo?.toLowerCase() === repo);

describe('evidence-backed pending client resolutions', () => {
  it('removes only the settled repository-wide pending entries and applies bounded overrides', () => {
    const overrides = loadClientRegistryOverrides();
    expect(overrides.pending.some(entry => [es, nvnm].includes(entry.id))).toBe(false);
    expect(overrides.pending.some(entry => entry.id === 'github:0xpolygon/cdk-erigon')).toBe(true);
    // EthStorage's 333/3333/3337 are storage-network IDs, not EVM chain IDs: the feed keeps es-node
    // on the registered EthStorage L2 chains and links nothing else.
    expect(overrides.repositories[es]).toMatchObject({ role: 'client', poll: true, keep: [3336, 3339] });
    expect(overrides.repositories[es]).not.toHaveProperty('add');
    expect(overrides.repositories[nvnm]).toMatchObject({ role: 'client', poll: true, keep: [1611, 787111], add: { 1611: 'node', 787111: 'node' } });
    for (const key of [es, nvnm]) expect(overrides.repositories[key].note).toContain('Sources: https://');
    expect(Object.keys(overrides.repositories[es]).sort()).toEqual(['keep', 'note', 'poll', 'role']);
    expect(Object.keys(overrides.repositories[nvnm]).sort()).toEqual(['add', 'keep', 'note', 'poll', 'role']);
    expect(overrides.repositories[es].note).toMatch(/110011.*unverified/);
    expect(getRepositoryInputs().overrides).toEqual(overrides);
  });

  it.each([333, 3332, 3333, 3336, 3337, 3339])('classifies es-node as a storage node at %s without upgrading source certainty', chainId => {
    const r = repository(chainId, 'ethstorage/es-node');
    expect(r).toMatchObject({ kind: 'node', status: 'partial', audit: 'qualified', reviewedAt: '2026-10-16' });
    expect(r.notes).toBeTruthy();
    expect(r.evidence.some(url => /ethstorage\/es-node\/blob\/[0-9a-f]{40}\//.test(url))).toBe(true);
    const output = getRepositoryInputs().networks.find(n => n.chainId === chainId).repositories.find(r => r.repo?.toLowerCase() === 'ethstorage/es-node');
    expect(output).toEqual(r);
  });

  it('keeps historical and development associations qualified, and unresolved ones out of the feed', () => {
    const historical = repository(3336, 'ethstorage/es-node');
    expect(historical).toMatchObject({ scope: 'historical_network', deployment: 'historical' });
    expect(historical.notes).toMatch(/does not explicitly set 3336/);
    expect(historical.notes).toMatch(/defaults to 3333/);
    const development = repository(3339, 'ethstorage/es-node');
    expect(development.notes).toMatch(/integration-test/);
    expect(development.notes).toMatch(/not confirmation/);
    expect(repository(3332, 'ethstorage/es-node').notes).toMatch(/remains unverified/);
    expect(repository(3337, 'ethstorage/es-node').notes).toMatch(/underlying EVM rollup 3335/);
    // The feed keeps es-node on the registered, qualified EthStorage L2 chains; the unverified
    // associations stay out.
    const keep = loadClientRegistryOverrides().repositories[es].keep;
    expect(keep).toEqual([3336, 3339]);
    for (const id of [3332, 110011]) expect(keep).not.toContain(id);
  });

  it.each([1611, 787111])('maps the NVNM full node to legacy network %s without conflating NEXT or retirement', chainId => {
    const r = repository(chainId, 'nvnm-chain/nvnmchain');
    expect(r).toMatchObject({ kind: 'node', scope: 'exact_network', deployment: 'unknown', status: 'partial', audit: 'qualified' });
    expect(r.notes).toMatch(/Legacy does not imply retired/);
    expect(r.notes).toMatch(/787222\/787223/);
    expect(r.evidence).toContain('https://github.com/NVNM-Chain/nvnmchain/blob/01ac019e0730179d8cdfe7e8852e20b6316a7eba/app/config.go#L17-L20');
    expect(loadClientRegistryOverrides().repositories[nvnm].keep).not.toContain(787222);
    expect(loadClientRegistryOverrides().repositories[nvnm].keep).not.toContain(787223);
  });
});
