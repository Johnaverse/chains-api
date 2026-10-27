/**
 * Which words in a fork's name say nothing about WHICH fork it is ("upgrade", "hard fork",
 * "mandatory", "release", "mainnet"), read from the feeds rather than listed in code.
 *
 * Every feed item that announces a fork carries the classifier's reading of it: the title as
 * written ("[Standard] Morph - Hoodi Mainnet - Upgrade to v0.6.4 (Celadon Fork)") and the fork's
 * name it took from that title ("Celadon"). A codename is kept in the name nearly every time it
 * is in a title — Glamsterdam, Alpenglow, Celadon in all of theirs — while "upgrade" was kept in
 * 2 of 111 titles and "release" in none of 87. So a word the classifier drops from the names of
 * the forks whose titles carry it is generic; new wording joins as the feeds use it.
 */

// Enough titles to tell a habit from a one-off, and the most often a generic word may still
// be kept (a source that calls its fork "Mandatory Upgrade" and nothing else).
const MIN_TITLES = 3;
const MAX_KEPT_SHARE = 0.15;

let generic = new Set();
let learnedFrom = null;

const tokens = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !/^v?\d+$/.test(t));

/**
 * Rebuild from fork mentions (the shape src/sources/forkFeeds.js builds: `title` and
 * `enrichment.fork.name`). Cheap to call repeatedly: memoized on the array.
 */
export function learnForkWords(mentions) {
  if (!Array.isArray(mentions) || mentions === learnedFrom) return;
  // One item announcing two forks is two mentions of one title: counted once, its words kept
  // when either name has them.
  const items = new Map();
  for (const m of mentions) {
    const key = m?.url ?? m?.title;
    if (!key) continue;
    if (!items.has(key)) items.set(key, { title: m.title, names: new Set() });
    for (const t of tokens(m?.enrichment?.fork?.name)) items.get(key).names.add(t);
  }
  const seen = new Map();
  const kept = new Map();
  for (const { title, names: name } of items.values()) {
    for (const t of new Set(tokens(title))) {
      seen.set(t, (seen.get(t) ?? 0) + 1);
      if (name.has(t)) kept.set(t, (kept.get(t) ?? 0) + 1);
    }
  }
  generic = new Set([...seen].filter(([t, n]) => n >= MIN_TITLES && (kept.get(t) ?? 0) / n <= MAX_KEPT_SHARE).map(([t]) => t));
  learnedFrom = mentions;
}

/** Whether this one word of a fork's name is generic (learned; see learnForkWords). */
export function isGenericForkWord(word) {
  return generic.has(String(word ?? '').toLowerCase());
}

export function _forkWordsForTests() {
  return generic;
}
