import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Admin decisions about cross-source conflicts, plus an audit trail of who decided what.
 *
 * A conflict with no decision is OPEN; that is the default and needs no record. A decision is
 * one of:
 *   acknowledged — real, and being tracked (reported upstream, fix pending)
 *   dismissed    — a false positive or accepted noise; the note says why
 *
 * Every change is appended to the history, including a reopen and a prune, so "who hid this
 * conflict, when, and why" always has an answer. The history is capped, oldest first out; the
 * decisions themselves are never capped.
 *
 * Persisted like the auth store: atomic temp-file-and-rename, serialized writes, mode 0600, and
 * a refusal to start on a corrupt file rather than silently forgetting every decision.
 */

export const STATES = Object.freeze({ ACKNOWLEDGED: 'acknowledged', DISMISSED: 'dismissed' });
const HISTORY_CAP = 2000;

export function createReviewStore({ file, now = Date.now }) {
  const decisions = new Map();
  let history = [];
  let loaded = null;
  let writeChain = Promise.resolve();

  async function persist() {
    writeChain = writeChain.catch(() => {}).then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, decisions: [...decisions.values()], history }, null, 2), { mode: 0o600 });
      await rename(tmp, file);
      await chmod(file, 0o600).catch(() => {});
    });
    return writeChain;
  }

  function load() {
    if (!loaded) {
      loaded = (async () => {
        let raw;
        try {
          raw = await readFile(file, 'utf8');
        } catch (err) {
          if (err?.code === 'ENOENT') return;
          throw err;
        }
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          throw new Error(`Conflict review file ${file} is not valid JSON; refusing to start with no decisions`);
        }
        for (const d of Array.isArray(data?.decisions) ? data.decisions : []) {
          if (d?.id && Object.values(STATES).includes(d.state)) decisions.set(d.id, d);
        }
        history = Array.isArray(data?.history) ? data.history.slice(-HISTORY_CAP) : [];
      })();
    }
    return loaded;
  }

  function audit(entry) {
    history.push({ at: new Date(now()).toISOString(), ...entry });
    if (history.length > HISTORY_CAP) history = history.slice(-HISTORY_CAP);
  }

  // What a decision remembers about its conflict, so the history stays readable after the
  // conflict itself has gone — resolved upstream, or a rule changed.
  const snapshotOf = (c) => ({
    rule: c.rule ?? null, type: c.type ?? null, chainId: c.chainId ?? null,
    chainName: c.chainName ?? null, message: c.message ?? null
  });

  return {
    load,

    async get(id) {
      await load();
      return decisions.get(id) ?? null;
    },

    async all() {
      await load();
      return [...decisions.values()];
    },

    /**
     * Record a decision (replacing any earlier one for this conflict).
     * @param {string} id conflict id
     * @param {object} input
     * @param {string} input.state one of STATES
     * @param {string} input.note why
     * @param {string} input.by the admin's email
     * @param {object} input.conflict the live conflict record, for the snapshot
     */
    async decide(id, { state, note, by, conflict }) {
      if (!Object.values(STATES).includes(state)) throw new Error(`Unknown state: ${state}`);
      await load();
      const decision = { id, state, note: note ?? '', by, at: new Date(now()).toISOString(), ...snapshotOf(conflict) };
      decisions.set(id, decision);
      audit({ action: state, id, by, note: decision.note, ...snapshotOf(conflict) });
      await persist();
      return decision;
    },

    /** Remove a decision, returning the conflict to open. @returns the removed decision, or null */
    async clear(id, { by, action = 'reopened', note = '' }) {
      await load();
      const existing = decisions.get(id);
      if (!existing) return null;
      decisions.delete(id);
      audit({ action, id, by, note, ...snapshotOf(existing) });
      await persist();
      return existing;
    },

    /** Newest first. */
    async history(limit = 100) {
      await load();
      return history.slice(-limit).reverse();
    },

    flush() {
      return writeChain.catch(() => {});
    }
  };
}
