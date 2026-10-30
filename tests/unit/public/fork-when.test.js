import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The dashboard's "when" for a fork, run from public/app.js itself.
const app = readFileSync(new URL('../../../public/app.js', import.meta.url), 'utf8');
const slice = (from, to) => app.slice(app.indexOf(from), app.indexOf(to));
const code = slice('const TL_EVIDENCE = {', 'const TL_STREAMS')
  + slice('function timelineActivationMs(u)', 'function timelineMatchesSearch');
const context = vm.createContext({});
vm.runInContext(`${code}; this.api = { undatedWhenText, evidenceOf, activationBlockOf };`, context);
const { undatedWhenText, evidenceOf, activationBlockOf } = context.api;

describe('an undated fork', () => {
  it('shows its block height, with the block-height evidence', () => {
    // Lugano on Amoy before its date was read: a Heimdall height, no date.
    const lugano = { name: 'Lugano', activationAt: null, activationEvidence: null, activationBlock: 47105000 };
    expect(undatedWhenText(lugano)).toBe(`block ${(47105000).toLocaleString()}`);
    expect(evidenceOf(lugano).label).toBe('block height');
  });

  it('is TBA only with no date, no time and no height', () => {
    const tba = { activationAt: null, activationEvidence: null, activationBlock: null };
    expect(undatedWhenText(tba)).toBe('date TBA');
    expect(evidenceOf(tba).label).toBe('date not announced');
  });

  it('leaves a dated fork to its date', () => {
    const dated = { activationAt: '2026-10-01T16:22:00.000Z', activationEvidence: 'stated', activationBlock: 54627000 };
    expect(activationBlockOf(dated)).toBeNull();
    expect(evidenceOf(dated).label).toBe('stated');
  });
});

describe('an undated past fork', () => {
  it('reads past, never TBA, with its height when stated', () => {
    expect(undatedWhenText({ activationAt: null, phase: 'past', activationBlock: null })).toBe('past');
    expect(undatedWhenText({ activationAt: null, phase: 'past', activationBlock: 5000 })).toBe(`past · block ${(5000).toLocaleString()}`);
    expect(evidenceOf({ activationAt: null, phase: 'past' }).label).toBe('past');
  });

  it('says why when the past is inferred from a later fork going live', () => {
    const fusaka = { activationAt: null, phase: 'past', pastInferred: { after: 'Fulu', at: '2025-12-03T21:49:11.000Z' } };
    const ev = evidenceOf(fusaka);
    expect(ev.label).toBe('past (inferred)');
    expect(ev.title).toContain('Fulu went live');
    expect(undatedWhenText(fusaka)).toBe('past');
  });
});

