import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { importChannelAvailability } from '../../../scripts/import-channel-availability.mjs';

const IMPORTED_AT = '2026-10-16T15:12:00.000Z';
const check = { url: 'https://t.me/example', status: 'unable_to_verify', checked_at_utc: '2026-10-11T15:55:35.925Z', activity_status: 'unknown', latest_observed_activity: null, notes: 'Fetch failed; not evidence of removal. Content may be cached.' };
const original = { platform: 'telegram', url: 'https://t.me/example', title: 'Example', verification: 'qualified', relationship: 'officially_endorsed', scope: 'project_family', access: 'invite_unverified', invitation: 'official_link_unverified', notes: 'Original qualification.', evidence: ['https://example.org/community'] };
const source = { platform: 'telegram', url: original.url, verification_status: original.verification, relationship: original.relationship, network_scope: original.scope, access_status: original.access, invitation_status: original.invitation, activity_status: 'unknown', latest_observed_activity: null, checked_at_utc: '2026-10-11T03:30:31.487Z', evidence_mode: 'saved_capture', current_availability_checks: [check], independent_verification: { status: 'qualified', notes: 'Earlier saved capture; activity unverified.', checked_at_utc: '2026-10-11T05:00:00Z', evidence_mode: 'saved_capture', source_urls: original.evidence } };
const published = () => ({ source: 'Discovery list', updatedAt: '2026-10-11T05:34:45Z', importedAt: '2026-10-11T06:34:29Z', networks: [{ chainId: 1, checkedAt: '2026-10-11T03:30:31.487Z', channels: [structuredClone(original)] }] });
const revision = () => ({ generated_at_utc: '2026-10-11T16:06:33.141345+00:00', networks: [{ network_id: '1', channels: [structuredClone(source)] }], availability_audit: { completed_at_utc: '2026-10-11T16:06:33.141345+00:00', limitations: ['Point-in-time; may be cached.'] } });

function run(changes) {
  const p = published(); const r = revision(); changes?.(p, r);
  return importChannelAvailability(p, r, IMPORTED_AT);
}

describe('availability-only channel importer', () => {
  it('preserves attribution, unknown/null activity, all evidence and original check dates', () => {
    const p = published(); const r = revision();
    const result = importChannelAvailability(p, r, IMPORTED_AT);
    expect(result.networks[0].channels[0]).toMatchObject(original);
    expect(result.networks[0].checkedAt).toBe(p.networks[0].checkedAt);
    expect(result.networks[0].channels[0]).toMatchObject({ activity: 'unknown', lastActivity: null, checkedAt: source.checked_at_utc, evidenceMode: 'saved_capture', current_availability_checks: [check], independent_verification: source.independent_verification });
    expect(result.availability_audit).toEqual(r.availability_audit);
    expect(result.updatedAt).toBe(r.generated_at_utc);
    expect(result.importedAt).toBe(IMPORTED_AT);
    expect(p).toEqual(published());
    result.networks[0].channels[0].current_availability_checks[0].notes = 'changed';
    expect(r).toEqual(revision());
  });

  it('matches exact chain ID and published URL, regardless of record ordering or shared URLs', () => {
    const p = published(); const r = revision();
    p.networks.push({ chainId: 2, channels: [structuredClone(original)] });
    r.networks.unshift({ network_id: '2', channels: [{ ...structuredClone(source), current_availability_checks: [{ ...check, notes: 'Chain 2 observation.' }] }] });
    const result = importChannelAvailability(p, r, IMPORTED_AT);
    expect(result.networks.map(n => n.chainId)).toEqual([1, 2]);
    expect(result.networks[0].channels[0].current_availability_checks[0].notes).toBe(check.notes);
    expect(result.networks[1].channels[0].current_availability_checks[0].notes).toBe('Chain 2 observation.');
  });

  it('keeps an explicit closure and later failed canonical retrieval separately', () => {
    const result = run((_p, r) => r.networks[0].channels[0].current_availability_checks.unshift({ ...check, status: 'removed_or_closed_explicit', activity_status: 'explicitly_closed', checked_at_utc: '2026-10-11T15:55:22.385Z', notes: 'Closed notice; cached last month.' }));
    expect(result.networks[0].channels[0].current_availability_checks.map(c => c.status)).toEqual(['removed_or_closed_explicit', 'unable_to_verify']);
    expect(result.networks[0].channels[0].activity).toBe('unknown');
  });

  it('does not add unresolved or repurposed source destinations', () => {
    const result = run((_p, r) => r.networks[0].channels.push({ ...source, url: 'https://t.me/unresolved', verification_status: 'unresolved' }, { ...source, url: 'https://t.me/repurposed', access_status: 'repurposed' }));
    expect(result.networks[0].channels).toHaveLength(1);
  });

  it.each(['unresolved', 'repurposed'])('rejects an existing row newly classified %s', status => {
    expect(() => run((_p, r) => { r.networks[0].channels[0][status === 'unresolved' ? 'verification_status' : 'access_status'] = status; })).toThrow('eligible exact source match');
  });

  it('rejects missing, extra, ambiguous, unsafe and attribution-drift matches', () => {
    expect(() => run((_p, r) => { r.networks[0].channels[0].url += '/'; })).toThrow('eligible exact source match');
    expect(() => run((_p, r) => r.networks[0].channels.push({ ...source, url: 'https://t.me/new' }))).toThrow('separate discovery-list review');
    expect(() => run((_p, r) => r.networks[0].channels.push(structuredClone(source)))).toThrow('Duplicate source channel');
    expect(() => run((_p, r) => r.networks.push(structuredClone(r.networks[0])))).toThrow('Duplicate source chain ID');
    expect(() => run(p => p.networks.push(structuredClone(p.networks[0])))).toThrow('Duplicate published chain ID');
    expect(() => run(p => p.networks[0].channels.push(structuredClone(original)))).toThrow('Duplicate published channel');
    expect(() => run((_p, r) => { r.networks[0].network_id = '9007199254740993'; })).toThrow('Invalid chain ID');
    expect(() => run((_p, r) => { r.networks[0].channels[0].url = 'javascript:alert(1)'; })).toThrow('Unsupported channel URL');
    expect(() => run((_p, r) => { r.networks[0].channels[0].network_scope = 'exact_network'; })).toThrow('Attribution/access changed');
    expect(() => run((_p, r) => { r.generated_at_utc = '2020-01-01T00:00:00Z'; })).toThrow('older availability revision');
    expect(() => run((_p, r) => { delete r.networks[0].channels[0].current_availability_checks; })).toThrow('Missing availability');
  });

  it('is deterministic when given the same import timestamp', () => {
    const first = run();
    expect(importChannelAvailability(first, revision(), IMPORTED_AT)).toEqual(first);
  });

  it('CLI writes a validated import and leaves its target untouched when validation fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'channel-import-'));
    try {
      const target = join(directory, 'target.json'); const input = join(directory, 'input.json');
      writeFileSync(target, JSON.stringify(published())); writeFileSync(input, JSON.stringify(revision()));
      const args = ['scripts/import-channel-availability.mjs', input, target, IMPORTED_AT];
      expect(spawnSync(process.execPath, args, { encoding: 'utf8' }).status).toBe(0);
      expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(run());
      const before = readFileSync(target, 'utf8');
      const bad = revision(); bad.networks[0].channels = []; writeFileSync(input, JSON.stringify(bad));
      expect(spawnSync(process.execPath, args, { encoding: 'utf8' }).status).toBe(1);
      expect(readFileSync(target, 'utf8')).toBe(before);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('checked-in October 11 availability revision', () => {
  const dataset = JSON.parse(readFileSync(new URL('../../../data/channel-research.json', import.meta.url), 'utf8'));
  const channels = dataset.networks.flatMap(n => n.channels);
  it('retains the curated membership and all availability checks', () => {
    expect(dataset.updatedAt).toBe('2026-10-11T16:06:33.141345+00:00');
    expect(dataset.networks).toHaveLength(1444); expect(channels).toHaveLength(4468);
    expect(channels.flatMap(c => c.current_availability_checks)).toHaveLength(4760);
    for (const c of channels) {
      expect(['confirmed', 'qualified']).toContain(c.verification); expect(c.access).not.toBe('repurposed');
      expect(c.independent_verification).toBeTruthy(); expect(c.activity).toBeTruthy();
      expect(c).toHaveProperty('lastActivity');
    }
  });
});
