import { describe, it, expect } from 'vitest';
import { renderMetrics } from '../../../src/util/metrics.js';

describe('renderMetrics — incident sentinel gauge', () => {
  it('emits nothing for the sentinel before its first run', () => {
    // The gauge is fed by whatever the last sentinel run left behind, and /metrics never
    // triggers one itself — so absence is the correct state on a fresh process, not a bug.
    const body = renderMetrics({});
    expect(body).not.toContain('chains_api_incident_sentinel_observations');
  });

  it('emits one series per rule once a run has happened', () => {
    const body = renderMetrics({
      incidentSummary: {
        s1_unrecognized_status: 178,
        s3_model_says_incident: 2,
        a1_inferred_chain_attribution: 5
      }
    });
    expect(body).toContain('chains_api_incident_sentinel_observations{rule="s1_unrecognized_status"} 178');
    expect(body).toContain('chains_api_incident_sentinel_observations{rule="s3_model_says_incident"} 2');
  });

  it('carries A1 without describing it as a contradiction', () => {
    // A1 is a grounding measurement the sentinel keeps out of its own findings total. A HELP
    // line calling the whole series "contradictions" would make a well-attributed feed read as
    // broken — the exact kind of internal disagreement this sentinel exists to report.
    const body = renderMetrics({ incidentSummary: { a1_inferred_chain_attribution: 5 } });
    expect(body).toContain('chains_api_incident_sentinel_observations{rule="a1_inferred_chain_attribution"} 5');

    const help = body.split('\n').find((l) => l.startsWith('# HELP chains_api_incident_sentinel'));
    expect(help).toBeDefined();
    expect(help).not.toMatch(/contradictions by rule/);
    expect(help).toMatch(/grounding measurements/);
  });

  it('declares the series as a gauge', () => {
    const body = renderMetrics({ incidentSummary: { s4_ongoing_terminal_status: 0 } });
    expect(body).toContain('# TYPE chains_api_incident_sentinel_observations gauge');
  });

  it('escapes a rule label rather than emitting a broken series', () => {
    const body = renderMetrics({ incidentSummary: { 'weird"rule': 1 } });
    expect(body).not.toContain('{rule="weird"rule"}');
  });
});
