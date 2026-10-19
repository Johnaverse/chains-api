import { forkIdentity } from './forks.js';

/**
 * Fork names learned from the feeds, never from a table. When the fork list finds several
 * names activating on the same chains at the same height or second (mergeSameActivation), they
 * are one fork: Hoodi's Glamsterdam, Gloas and Amsterdam on 2026-10-26 17:42:48. The
 * best-attested name (the entity's own) becomes the one the others resolve to, so a release
 * elsewhere that says only "Amsterdam" joins that fork without anyone listing the pair.
 */
let canonicalOf = new Map(); // identity -> canonical identity
let displayOf = new Map(); // canonical identity -> the name as written
let membersOf = new Map(); // canonical identity -> every identity resolving to it

/** Learn from fork entities ({name, aliases, events}). Replaces what was learned before. */
export function learnForkNames(forks = []) {
  const next = new Map();
  const display = new Map();
  const weight = new Map();
  // Best-attested entities first, so a name claimed by two entities follows the stronger one.
  const ranked = forks.filter((f) => f?.name && f.aliases?.length)
    .sort((a, b) => (b.events?.length ?? 0) - (a.events?.length ?? 0));
  for (const fork of ranked) {
    const canonical = forkIdentity(fork.name);
    if (!canonical) continue;
    // A name already resolving elsewhere stays there: chains of renames stay one hop.
    const root = next.get(canonical) ?? canonical;
    if (!display.has(root)) display.set(root, fork.name);
    for (const alias of fork.aliases) {
      const id = forkIdentity(alias);
      if (!id || id === root || next.has(id)) continue;
      next.set(id, root);
    }
    weight.set(root, (weight.get(root) ?? 0) + (fork.events?.length ?? 0));
  }
  const members = new Map();
  for (const [id, root] of next) {
    if (!members.has(root)) members.set(root, [root]);
    members.get(root).push(id);
  }
  canonicalOf = next;
  displayOf = display;
  membersOf = members;
}

/** The identity a fork name identity resolves to (itself when nothing was learned). */
export function canonicalForkId(id) {
  return canonicalOf.get(id) ?? id;
}

/** Every identity known to resolve to this canonical one (itself included). */
export function forkIdsOf(canonical) {
  return membersOf.get(canonical) ?? [canonical];
}

/** The name as the feeds wrote it, for a canonical identity. */
export function forkDisplayName(canonical) {
  return displayOf.get(canonical) ?? null;
}

export function _resetForkNamesForTests() {
  canonicalOf = new Map();
  displayOf = new Map();
  membersOf = new Map();
}
