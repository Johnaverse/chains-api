import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DATA_CACHE_ENABLED, DATA_CACHE_FILE } from '../../config.js';
import { logger } from '../util/logger.js';

/**
 * User feedback store: reports of wrong info ("this incident isn't related to
 * that upgrade", "wrong version"). Automation correlates feeds by heuristics;
 * this is the human loop that catches what the heuristics get wrong.
 *
 * Storage is deliberately lightweight: an in-memory ring capped at
 * MAX_FEEDBACK (newest kept), mirrored best-effort as one JSON line per
 * record into feedback.jsonl next to the data cache when DATA_CACHE_ENABLED.
 * Persistence failures only warn — losing a report must never fail the
 * request that carried it. On first use the ring hydrates from that file so
 * restarts don't lose reports. Records carry NO IP or user-agent (privacy):
 * only what the reporter typed plus a server id/timestamp.
 */

const MAX_FEEDBACK = 1000;
// Lives next to the data cache snapshot (.cache/feedback.jsonl by default),
// so a DATA_CACHE_FILE override relocates both together.
const FEEDBACK_FILE = join(dirname(DATA_CACHE_FILE), 'feedback.jsonl');

const state = {
  items: [],          // oldest → newest, capped at MAX_FEEDBACK
  hydrated: false,    // file read attempted (success or not) — only ever once
  persist: DATA_CACHE_ENABLED
};

function capItems() {
  if (state.items.length > MAX_FEEDBACK) state.items.splice(0, state.items.length - MAX_FEEDBACK);
}

// Best-effort, once: seed the ring from the JSONL file so restarts keep
// reports. A missing file is the normal first run; a corrupt line is skipped
// (append can race a crash mid-write) rather than discarding the rest.
async function hydrateOnce() {
  if (state.hydrated) return;
  state.hydrated = true;
  if (!state.persist) return;
  let raw;
  try {
    raw = await readFile(FEEDBACK_FILE, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') logger.warn({ err: err.message }, 'Failed to read feedback file');
    return;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { state.items.push(JSON.parse(line)); } catch { /* skip torn line */ }
  }
  capItems();
}

/**
 * Record one feedback report. The body is already schema-validated by the
 * route; this adds the server-side identity (id + receivedAt) and stores it.
 * @param {object} body validated report ({kind, reason, refId?, comment?, page?})
 * @returns {Promise<object>} the stored record
 */
export async function addFeedback(body) {
  await hydrateOnce();
  const record = { id: randomUUID(), receivedAt: new Date().toISOString(), ...body };
  state.items.push(record);
  capItems();
  if (state.persist) {
    try {
      await mkdir(dirname(FEEDBACK_FILE), { recursive: true });
      await appendFile(FEEDBACK_FILE, JSON.stringify(record) + '\n');
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to persist feedback record');
    }
  }
  return record;
}

/**
 * List stored reports, newest-first, in the project's contract envelope.
 * @param {object} [options]
 * @param {string} [options.kind] only reports of this kind
 * @param {number} [options.limit] max returned (default 50, max 500)
 * @returns {Promise<{totalMatched: number, count: number, truncated: boolean, feedback: object[]}>}
 */
export async function listFeedback({ kind, limit = 50 } = {}) {
  await hydrateOnce();
  const matched = kind ? state.items.filter((r) => r.kind === kind) : state.items;
  const capped = Math.max(1, Math.min(Number(limit) || 50, 500));
  const sliced = matched.slice(-capped).reverse(); // newest-first
  return {
    totalMatched: matched.length,
    count: sliced.length,
    truncated: matched.length > sliced.length,
    feedback: sliced
  };
}

// Tests: empty the ring and (by default) turn persistence off so unit runs
// neither read nor write the real .cache/feedback.jsonl.
export function _resetFeedbackForTests({ persist = false } = {}) {
  state.items = [];
  state.hydrated = true;
  state.persist = persist;
}
