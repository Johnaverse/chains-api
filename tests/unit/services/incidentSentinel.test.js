import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildIncidentSentinel,
  runIncidentSentinel,
  getLastIncidentSentinelSummary,
  _resetIncidentSentinelForTests
} from '../../../src/services/incidentSentinel.js';
import { getLiveEvents, getLiveEventsFetchedAt } from '../../../src/sources/liveIncidents.js';

vi.mock('../../../src/sources/liveIncidents.js', () => ({
  getLiveEvents: vi.fn(),
  getLiveEventsFetchedAt: vi.fn()
}));

/** A normalized feed event, shaped like src/sources/liveIncidents.js emits. */
function ev(overrides = {}) {
  return {
    title: 'Something happened',
    statusPage: { id: 'chainstack', name: 'Chainstack', kind: 'rpc-provider' },
    incidentId: 'inc-1',
    publishedAt: '2026-09-01T00:00:00.000Z',
    status: 'investigating',
    ongoing: null,
    isWindowEntry: false,
    chains: [],
    ...overrides
  };
}

describe('incidentSentinel', () => {
  beforeEach(() => {
    _resetIncidentSentinelForTests();
    vi.clearAllMocks();
  });

  describe('S1 — status outside the known vocabulary', () => {
    it('flags the literal `unknown` the feed passes through unvalidated', () => {
      const report = buildIncidentSentinel([ev({ status: 'unknown' })]);
      expect(report.rules.s1_unrecognized_status.count).toBe(1);
      expect(report.rules.s1_unrecognized_status.sample[0].status).toBe('unknown');
    });

    it('reports the share, which is the number a consumer actually needs', () => {
      // The regression this rule exists for: a consumer assumed unrecognized statuses were
      // rare. Reporting only a count invites the same assumption; the share refuses it.
      const events = [
        ...Array.from({ length: 3 }, () => ev({ status: 'unknown' })),
        ev({ status: 'investigating' })
      ];
      const report = buildIncidentSentinel(events);
      expect(report.rules.s1_unrecognized_status.count).toBe(3);
      expect(report.rules.s1_unrecognized_status.share).toBe(75);
    });

    it('accepts every status the shared vocabularies define', () => {
      const known = [
        'investigating', 'identified', 'monitoring', 'resolved',
        'degraded', 'partial_outage', 'major_outage',
        'maintenance_scheduled', 'maintenance_in_progress', 'maintenance_completed',
        'operational'
      ];
      const report = buildIncidentSentinel(known.map((status) => ev({ status })));
      expect(report.rules.s1_unrecognized_status.count).toBe(0);
    });

    it('counts an absent status as absent, not as unrecognized', () => {
      // §14: "unknown is null, never a stand-in" cuts both ways — a null the feed is entitled
      // to send is not the same finding as a value nobody recognizes.
      const report = buildIncidentSentinel([ev({ status: null })]);
      expect(report.rules.s1_unrecognized_status.count).toBe(0);
      expect(report.coverage.statusAbsent).toBe(1);
    });
  });

  describe('S2/S3 — model disagrees with the operator', () => {
    it('flags planned-work class under a live incident status', () => {
      const report = buildIncidentSentinel([
        ev({ status: 'major_outage', enrichment: { class: 'planned_hard_fork' } })
      ]);
      expect(report.rules.s2_model_says_planned.count).toBe(1);
    });

    it('does not fire on a resolved entry, where the disagreement proves nothing', () => {
      const report = buildIncidentSentinel([
        ev({ status: 'resolved', enrichment: { class: 'planned_hard_fork' } })
      ]);
      expect(report.rules.s2_model_says_planned.count).toBe(0);
    });

    it('flags an incident class under a maintenance status — an outage inside a window', () => {
      const report = buildIncidentSentinel([
        ev({ status: 'maintenance_in_progress', enrichment: { class: 'chain_halt' } })
      ]);
      expect(report.rules.s3_model_says_incident.count).toBe(1);
      expect(report.rules.s3_model_says_incident.sample[0]).toMatchObject({
        class: 'chain_halt', status: 'maintenance_in_progress'
      });
    });

    it('agreement produces no finding in either direction', () => {
      const report = buildIncidentSentinel([
        ev({ status: 'major_outage', enrichment: { class: 'chain_halt' } }),
        ev({ status: 'maintenance_scheduled', enrichment: { class: 'scheduled_maintenance' } })
      ]);
      expect(report.rules.s2_model_says_planned.count).toBe(0);
      expect(report.rules.s3_model_says_incident.count).toBe(0);
    });
  });

  describe('S4 — ongoing under a terminal status', () => {
    it('flags ongoing:true on a resolved entry', () => {
      const report = buildIncidentSentinel([ev({ status: 'resolved', ongoing: true })]);
      expect(report.rules.s4_ongoing_terminal_status.count).toBe(1);
    });

    it('does not flag ongoing:true on a live status', () => {
      const report = buildIncidentSentinel([ev({ status: 'investigating', ongoing: true })]);
      expect(report.rules.s4_ongoing_terminal_status.count).toBe(0);
    });
  });

  describe('S5 — class vocabulary drift', () => {
    it('flags a class outside the documented set', () => {
      const report = buildIncidentSentinel([ev({ enrichment: { class: 'rug_pull' } })]);
      expect(report.rules.s5_unrecognized_class.count).toBe(1);
    });

    it('treats documented-but-unassignable classes as known, not drift', () => {
      // `chain_hardfork` and `other` are real classes that cannot be sorted into planned vs
      // incident without guessing, so they must produce neither drift nor a conflict.
      const report = buildIncidentSentinel([
        ev({ status: 'maintenance_in_progress', enrichment: { class: 'chain_hardfork' } }),
        ev({ status: 'major_outage', enrichment: { class: 'other' } })
      ]);
      expect(report.rules.s5_unrecognized_class.count).toBe(0);
      expect(report.rules.s2_model_says_planned.count).toBe(0);
      expect(report.rules.s3_model_says_incident.count).toBe(0);
    });
  });

  describe('S6 — window banner vs status (§12)', () => {
    it('flags a banner entry under an incident status', () => {
      const report = buildIncidentSentinel([ev({ isWindowEntry: true, status: 'investigating' })]);
      expect(report.rules.s6_window_banner_status_mismatch.count).toBe(1);
    });

    it('accepts a banner entry labelled maintenance_completed up front, as §12 describes', () => {
      const report = buildIncidentSentinel([
        ev({ isWindowEntry: true, status: 'maintenance_completed' })
      ]);
      expect(report.rules.s6_window_banner_status_mismatch.count).toBe(0);
    });
  });

  describe('A1 — chains named only by the model', () => {
    it('records inferred attribution without calling it an error', () => {
      const report = buildIncidentSentinel([
        ev({ chains: [{ chainId: 1, name: 'Ethereum' }], enrichment: { chains: [1, 10, 8453] } })
      ]);
      const a1 = report.rules.a1_inferred_chain_attribution;
      expect(a1.count).toBe(1);
      expect(a1.sample[0].inferredChains).toEqual([10, 8453]);
      // Grounding measurement, not a contradiction — it must not inflate the headline.
      expect(report.totalFindings).toBe(0);
    });

    it('says nothing when the model only echoes declared chains', () => {
      const report = buildIncidentSentinel([
        ev({ chains: [{ chainId: 1, name: 'Ethereum' }], enrichment: { chains: [1] } })
      ]);
      expect(report.rules.a1_inferred_chain_attribution.count).toBe(0);
    });
  });

  describe('report shape', () => {
    it('caps samples but never the counts', () => {
      const report = buildIncidentSentinel(
        Array.from({ length: 25 }, () => ev({ status: 'unknown' }))
      );
      expect(report.rules.s1_unrecognized_status.count).toBe(25);
      expect(report.rules.s1_unrecognized_status.sample).toHaveLength(10);
    });

    it('tolerates an empty feed and a non-array argument', () => {
      for (const input of [[], undefined, null]) {
        const report = buildIncidentSentinel(input);
        expect(report.totalEvents).toBe(0);
        expect(report.totalFindings).toBe(0);
      }
    });

    it('tolerates events with no enrichment and no chains', () => {
      const report = buildIncidentSentinel([{ title: 'bare' }]);
      expect(report.totalFindings).toBe(0);
      expect(report.coverage.withEnrichment).toBe(0);
    });

    it('exposes no summary for /metrics until a run has happened', () => {
      expect(getLastIncidentSentinelSummary()).toBeNull();
    });
  });

  describe('runIncidentSentinel', () => {
    it('reports over the live feed and carries the feed\'s own fetchedAt', async () => {
      getLiveEvents.mockResolvedValue([ev({ status: 'unknown' })]);
      getLiveEventsFetchedAt.mockReturnValue('2026-09-17T10:00:00.000Z');

      const report = await runIncidentSentinel();
      expect(report.fetchedAt).toBe('2026-09-17T10:00:00.000Z');
      expect(report.totalEvents).toBe(1);
      expect(report.summary.s1_unrecognized_status).toBe(1);
    });

    it('publishes the summary for /metrics to read without fetching', async () => {
      // /metrics must never trigger a feed fetch of its own, so the gauge can only come from
      // whatever the last run left behind.
      getLiveEvents.mockResolvedValue([ev({ status: 'resolved', ongoing: true })]);
      getLiveEventsFetchedAt.mockReturnValue(null);

      expect(getLastIncidentSentinelSummary()).toBeNull();
      await runIncidentSentinel();
      expect(getLastIncidentSentinelSummary().s4_ongoing_terminal_status).toBe(1);
      expect(getLiveEvents).toHaveBeenCalledTimes(1);
    });

    it('lets a feed failure propagate so the route can answer 503', async () => {
      getLiveEvents.mockRejectedValue(new Error('feed down'));
      await expect(runIncidentSentinel()).rejects.toThrow('feed down');
    });
  });
});
