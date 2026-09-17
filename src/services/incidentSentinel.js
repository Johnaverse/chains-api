import { getLiveEvents, getLiveEventsFetchedAt } from '../sources/liveIncidents.js';
import { MAINTENANCE_STATUSES, INCIDENT_STATUSES } from './upgrades.js';

/**
 * Incident-feed sentinel: contradictions in what the feed and its LLM enrichment assert.
 *
 * `validation.js` already does this for the chain registry — 17 rules that fire when two
 * sources disagree about one chain. The incident + enrichment path never got an equivalent,
 * and the cost has been concrete: a status vocabulary nobody was counting (a literal
 * `unknown` on a large share of events) was rediscovered only after a consumer shipped a
 * change that assumed it away. A contradiction nothing looks for is one every consumer has
 * to rediscover.
 *
 * Two families, named for what they answer:
 *   S rules — INTERNAL consistency. Do the feed's own assertions contradict each other, or
 *             contradict the model's classification of them?
 *   A rules — GROUNDING. Can a claim be traced to who stated it? This is SERVICE-CONTRACT
 *             §14 ("a consumer must be able to tell a value that was STATED from one that was
 *             inferred") applied to enrichment, which §14 itself does not yet cover.
 *
 * This module REPORTS. It does not suppress an event or rewrite a classification: the same
 * discipline §14 states for values applies to findings, so a rule says what it saw and the
 * consumer decides. Suppression is a separate, deliberate change — it would alter what the
 * assistant and the MCP tools see.
 */

// `operational` belongs to neither shared set but is a real page state the feed emits, so it
// is known-and-not-a-problem rather than a vocabulary violation.
const KNOWN_STATUSES = new Set([...MAINTENANCE_STATUSES, ...INCIDENT_STATUSES, 'operational']);

// A status that means an incident is LIVE. `resolved` is deliberately excluded: the model
// calling a resolved entry "planned" is weak evidence of anything, and folding it in here
// would bury the live disagreements that matter under closed ones.
const LIVE_INCIDENT_STATUSES = new Set(
  [...INCIDENT_STATUSES].filter((s) => s !== 'resolved')
);

// ONLY the class names docs/SERVICE-CONTRACT.md §8 states verbatim. §8 records that the two
// feeds do not share a vocabulary and lists each with a trailing "…", so the full set is not
// knowable from the contract — and guessing at the remainder is how a rule invents findings.
// Anything outside these is counted as drift (S5) rather than forced into a bucket.
const PLANNED_CLASSES = new Set(['planned_hard_fork', 'scheduled_maintenance']);
const INCIDENT_CLASSES = new Set(['chain_halt', 'provider_incident', 'chain_incident']);
// Documented, but not assignable to either side without guessing. `chain_hardfork` does not
// say whether the fork was planned or an emergency response, and `other` is the model's own
// "I don't know" (providerStats.js records upstream flagging roughly a third of enrichments
// low-confidence, mostly this class). Known, so not drift; unassigned, so never a conflict.
const UNASSIGNED_CLASSES = new Set(['chain_hardfork', 'other']);
const KNOWN_CLASSES = new Set([...PLANNED_CLASSES, ...INCIDENT_CLASSES, ...UNASSIGNED_CLASSES]);

const TERMINAL_STATUSES = new Set(['resolved', 'maintenance_completed']);

// Findings carry a capped sample rather than every hit, following the same rule CLAUDE.md
// sets for collection tools: honest counts, a sample to act on. S1 alone can match hundreds
// of events, and a consumer that needs all of them wants the feed, not this report.
const SAMPLE_LIMIT = 10;

function describe(ev) {
  return {
    title: ev.title ?? null,
    statusPage: ev.statusPage?.id ?? null,
    incidentId: ev.incidentId ?? null,
    publishedAt: ev.publishedAt ?? null
  };
}

function rule(id, title, detail) {
  return { rule: id, title, detail, count: 0, sample: [] };
}

function hit(bucket, ev, evidence) {
  bucket.count += 1;
  if (bucket.sample.length < SAMPLE_LIMIT) bucket.sample.push({ ...describe(ev), ...evidence });
}

/**
 * Run every rule over a list of normalized feed events.
 *
 * Pure so the rules are testable without the network, matching `buildProviderStats`.
 *
 * @param {object[]} events normalized events from `src/sources/liveIncidents.js`
 * @returns {object} report with per-rule counts, shares and capped samples
 */
export function buildIncidentSentinel(events = []) {
  const list = Array.isArray(events) ? events : [];

  const rules = {
    s1_unrecognized_status: rule(
      'S1', 'Status outside the known vocabulary',
      'The feed passes `status` through unvalidated. A consumer that treats an unrecognized '
      + 'value as live inverts the default for every event carrying one.'
    ),
    s2_model_says_planned: rule(
      'S2', 'Model classified planned work, operator reports a live incident',
      'The enrichment class names planned work while the operator\'s own status says an '
      + 'incident is live. Published state outranks the model, so the classification is the '
      + 'suspect side.'
    ),
    s3_model_says_incident: rule(
      'S3', 'Model classified an incident, operator reports maintenance',
      'The reverse disagreement, and the one worth a human: it is the shape of a real '
      + 'incident occurring inside a maintenance window. Reported for follow-up rather than '
      + 'reclassified — the operator may simply not have changed the status yet, and acting '
      + 'on the model alone would let a misclassification manufacture an outage.'
    ),
    s4_ongoing_terminal_status: rule(
      'S4', 'Feed marks the event ongoing under a terminal status',
      'Self-contradiction inside one event. §13 makes `ongoing` the authoritative live '
      + 'signal, so this pits the authority against the status it travels with.'
    ),
    s5_unrecognized_class: rule(
      'S5', 'Enrichment class outside the documented vocabulary',
      'Measures the drift §8 predicts. Growing the recognized set from this list is how the '
      + 'other class rules stay honest.'
    ),
    s6_window_banner_status_mismatch: rule(
      'S6', 'Window banner present under a non-maintenance status',
      '§12: the `THIS IS A SCHEDULED EVENT` banner identifies a window entry, not `status`. '
      + 'A banner under an incident status means the two disagree about what the entry is.'
    ),
    a1_inferred_chain_attribution: rule(
      'A1', 'Chains named only by the model, not declared by the operator',
      'Not a defect — §14 grounding. These associations are real signal (an OP Stack window '
      + 'touching networks it never lists), but they are INFERRED, and a surface that merges '
      + 'them into declared chains would let a model guess mark a network affected.'
    )
  };

  let withEnrichment = 0;
  let statusAbsent = 0;

  for (const ev of list) {
    const status = typeof ev?.status === 'string' ? ev.status : null;
    const enr = ev?.enrichment ?? null;
    const cls = typeof enr?.class === 'string' ? enr.class : null;
    if (enr) withEnrichment += 1;

    // Absent is not unrecognized: the feed is allowed not to know, and §14 wants that
    // distinguished from a value it does carry but nobody recognizes.
    if (status === null) {
      statusAbsent += 1;
    } else if (!KNOWN_STATUSES.has(status)) {
      hit(rules.s1_unrecognized_status, ev, { status });
    }

    if (cls) {
      if (!KNOWN_CLASSES.has(cls)) hit(rules.s5_unrecognized_class, ev, { class: cls });
      if (PLANNED_CLASSES.has(cls) && status && LIVE_INCIDENT_STATUSES.has(status)) {
        hit(rules.s2_model_says_planned, ev, { class: cls, status });
      }
      if (INCIDENT_CLASSES.has(cls) && status && MAINTENANCE_STATUSES.has(status)) {
        hit(rules.s3_model_says_incident, ev, { class: cls, status });
      }
    }

    if (ev?.ongoing === true && status && TERMINAL_STATUSES.has(status)) {
      hit(rules.s4_ongoing_terminal_status, ev, { status });
    }

    if (ev?.isWindowEntry === true && status && !MAINTENANCE_STATUSES.has(status)) {
      hit(rules.s6_window_banner_status_mismatch, ev, { status });
    }

    const declared = new Set(
      (Array.isArray(ev?.chains) ? ev.chains : [])
        .map((c) => c?.chainId)
        .filter((id) => id != null)
    );
    const inferredOnly = (Array.isArray(enr?.chains) ? enr.chains : [])
      .filter((id) => Number.isFinite(id) && !declared.has(id));
    if (inferredOnly.length) {
      hit(rules.a1_inferred_chain_attribution, ev, {
        declaredChains: [...declared],
        inferredChains: inferredOnly
      });
    }
  }

  const totalEvents = list.length;
  const share = (n) => (totalEvents ? Math.round((n / totalEvents) * 10000) / 100 : 0);
  for (const bucket of Object.values(rules)) bucket.share = share(bucket.count);

  const summary = {};
  let totalFindings = 0;
  for (const [key, bucket] of Object.entries(rules)) {
    summary[key] = bucket.count;
    // A1 is a grounding measurement, not a contradiction, so it stays out of the headline
    // count — otherwise a healthy feed that attributes chains well looks broken.
    if (key !== 'a1_inferred_chain_attribution') totalFindings += bucket.count;
  }

  return {
    totalEvents,
    totalFindings,
    coverage: {
      withEnrichment,
      enrichmentShare: share(withEnrichment),
      statusAbsent,
      statusAbsentShare: share(statusAbsent)
    },
    summary,
    rules
  };
}

// Last computed summary, for /metrics. The scrape endpoint must never trigger a feed fetch:
// a third-party outage would then take metrics down with it, and a gauge that blocks on the
// network is worse than a gauge that is briefly absent.
let lastSummary = null;

/** @returns {object|null} the most recent run's per-rule counts, or null if never run */
export function getLastIncidentSentinelSummary() {
  return lastSummary;
}

/** Test-only helper. */
export function _resetIncidentSentinelForTests() {
  lastSummary = null;
}

/**
 * Fetch the live feed and run every rule over it.
 *
 * @returns {Promise<object>} the report, plus the feed's own `fetchedAt`
 */
export async function runIncidentSentinel() {
  const events = await getLiveEvents();
  const report = buildIncidentSentinel(events);
  lastSummary = report.summary;
  return { fetchedAt: getLiveEventsFetchedAt(), ...report };
}
