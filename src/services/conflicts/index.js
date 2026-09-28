import { CONFLICT_REVIEWS_FILE } from '../../../config.js';
import { validateChainData } from '../validation.js';
import { conflictId, evidenceOf, RULE_LABELS } from './identity.js';
import { createReviewStore, STATES } from './reviewStore.js';

/**
 * Cross-source conflicts, as an admin manages them.
 *
 * The conflicts themselves are recomputed from the live data on every read — that is what
 * /validate has always done, and it means a conflict fixed upstream simply stops appearing.
 * What persists is only the admin's decision about each one, keyed by the stable identity in
 * identity.js. Merging the two gives four states:
 *
 *   open          — occurs now, nobody has decided
 *   acknowledged  — occurs now, known and being tracked
 *   dismissed     — occurs now, judged a false positive or accepted noise
 *   resolved      — was decided on, and NO LONGER OCCURS: the upstream source fixed it, or its
 *                   value changed (so it is back as a new, open conflict)
 *
 * The last is worth surfacing rather than hiding: it is the payoff of the review loop — "you
 * reported this upstream; it is fixed now" — and the decision can then be cleared.
 */

export class ConflictError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const REVIEW_STATES = Object.freeze(['open', STATES.ACKNOWLEDGED, STATES.DISMISSED]);
const NOTE_MAX = 1000;

/**
 * @param {object} deps
 * @param {() => object} [deps.validate] the validation run (validateChainData)
 * @param {object} deps.store a review store
 */
export function createConflictService({ validate = validateChainData, store }) {
  // One validation run, merged with every decision. Never cached: an admin acting on a
  // conflict must see the data as it is, not as it was thirty seconds ago.
  async function snapshot() {
    const report = validate();
    if (report?.error) throw new ConflictError(503, report.error);

    const decisions = new Map((await store.all()).map((d) => [d.id, d]));
    const live = new Map();
    for (const c of Array.isArray(report.allErrors) ? report.allErrors : []) {
      const id = conflictId(c);
      const seen = live.get(id);
      if (seen) { seen.occurrences += 1; continue; }
      const d = decisions.get(id);
      live.set(id, {
        id,
        rule: c.rule,
        ruleLabel: RULE_LABELS[c.rule] ?? `Rule ${c.rule}`,
        type: c.type,
        chainId: c.chainId ?? null,
        chainName: c.chainName ?? null,
        message: c.message,
        severity: c.severity ?? null,
        evidence: evidenceOf(c),
        occurrences: 1,
        state: d?.state ?? 'open',
        review: d ? { state: d.state, note: d.note, by: d.by, at: d.at } : null,
        raw: c
      });
    }
    const resolved = [...decisions.values()].filter((d) => !live.has(d.id));
    return { live, resolved };
  }

  function matches(item, { state, rule, q }) {
    if (state && state !== 'all' && item.state !== state) return false;
    if (rule && item.rule !== rule) return false;
    if (q) {
      const needle = q.trim().toLowerCase();
      if (!needle) return true;
      const hay = [item.chainName, item.message, item.type, item.ruleLabel, String(item.chainId ?? '')]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  }

  // `raw` is the untouched validation record, kept only to snapshot into a decision.
  const publicItem = ({ raw, ...rest }) => rest;

  return {
    /**
     * The review queue: counts for every state, a per-rule breakdown, and one page of items.
     * Counts are for the WHOLE set, not the filtered page, so the tabs always tell the truth.
     */
    async list({ state = 'open', rule, q, limit = 100, offset = 0 } = {}) {
      const { live, resolved } = await snapshot();
      const items = [...live.values()];
      const counts = { open: 0, acknowledged: 0, dismissed: 0, resolved: resolved.length, total: items.length };
      const byRule = new Map();
      for (const it of items) {
        counts[it.state] += 1;
        const r = byRule.get(it.rule) ?? { rule: it.rule, label: it.ruleLabel, open: 0, total: 0 };
        r.total += 1;
        if (it.state === 'open') r.open += 1;
        byRule.set(it.rule, r);
      }
      const filtered = items
        .filter((it) => matches(it, { state, rule, q }))
        .sort((a, b) => a.rule - b.rule || String(a.chainName ?? '').localeCompare(String(b.chainName ?? '')) || (a.chainId ?? 0) - (b.chainId ?? 0));
      return {
        counts,
        byRule: [...byRule.values()].sort((a, b) => a.rule - b.rule),
        totalMatched: filtered.length,
        offset,
        limit,
        items: filtered.slice(offset, offset + limit).map(publicItem),
        resolved: resolved.sort((a, b) => String(b.at).localeCompare(String(a.at)))
      };
    },

    /**
     * Acknowledge, dismiss, or reopen ('open') a conflict that occurs NOW. Deciding on an id
     * that is not live is refused: a decision must always be about something an admin could
     * see, never a guessed or stale id.
     */
    async review(id, { state, note = '' }, by) {
      if (!REVIEW_STATES.includes(state)) throw new ConflictError(400, `State must be one of: ${REVIEW_STATES.join(', ')}`);
      const text = String(note ?? '').trim();
      if (text.length > NOTE_MAX) throw new ConflictError(400, `Note too long. Max length: ${NOTE_MAX}`);
      // Hiding a conflict from everyone is the consequential act, so it has to say why.
      if (state === STATES.DISMISSED && !text) throw new ConflictError(400, 'Say why this conflict is being dismissed.');

      const { live } = await snapshot();
      const item = live.get(id);
      if (!item) throw new ConflictError(404, 'No such conflict right now. It may have been resolved upstream.');

      if (state === 'open') {
        await store.clear(id, { by, action: 'reopened', note: text });
        return { ...publicItem(item), state: 'open', review: null };
      }
      const d = await store.decide(id, { state, note: text, by, conflict: item.raw });
      return { ...publicItem(item), state: d.state, review: { state: d.state, note: d.note, by: d.by, at: d.at } };
    },

    /** Clear every decision whose conflict no longer occurs. @returns {Promise<number>} */
    async pruneResolved(by) {
      const { resolved } = await snapshot();
      for (const d of resolved) await store.clear(d.id, { by, action: 'pruned', note: 'No longer occurs' });
      return resolved.length;
    },

    history(limit = 100) {
      return store.history(limit);
    },

    /**
     * Annotate a /validate report IN PLACE with each conflict's id and review state, plus
     * counts. Purely additive — every existing field keeps its meaning, `totalErrors`
     * included — so current consumers are untouched and new ones can show "12 open, 30
     * reviewed". Notes and reviewer identities stay admin-only.
     */
    async annotate(report) {
      if (!report || report.error) return report;
      const decisions = new Map((await store.all()).map((d) => [d.id, d]));
      const seen = new Set();
      const review = { open: 0, acknowledged: 0, dismissed: 0 };
      for (const c of Array.isArray(report.allErrors) ? report.allErrors : []) {
        c.id = conflictId(c);
        c.reviewState = decisions.get(c.id)?.state ?? 'open';
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        review[c.reviewState] += 1;
      }
      report.review = review;
      return report;
    }
  };
}

let current = null;

/** The process-wide conflict service. */
export function getConflicts() {
  if (!current) current = createConflictService({ store: createReviewStore({ file: CONFLICT_REVIEWS_FILE }) });
  return current;
}

/** Test-only. */
export function _setConflictsForTests(service) {
  current = service;
}
