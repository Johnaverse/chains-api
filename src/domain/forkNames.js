import { forkIdentity } from './forks.js';

/**
 * Fork names learned from the feeds, never from a table. A source may state an alias itself
 * ("Fusaka (Fulu)"); otherwise when the fork list finds several names activating on the same
 * chains at the same height or second (mergeSameActivation), they are one fork: Hoodi's Glamsterdam, Gloas and Amsterdam on 2026-10-26 17:42:48. The
 * best-attested name (the entity's own) becomes the one the others resolve to, so a release
 * elsewhere that says only "Amsterdam" joins that fork without anyone listing the pair.
 */
let canonicalOf = new Map(); // identity -> canonical identity
let displayOf = new Map(); // canonical identity -> the name as written
let membersOf = new Map(); // canonical identity -> every identity resolving to it

/**
 * A name that states its own alias: "Fusaka (Fulu)" says Fulu is Fusaka, "Glamsterdam/ePBS
 * (Gloas)" that Gloas is Glamsterdam. Only the bracket form counts: "Berlin/London" lists two
 * forks, so of a slash list only the first is taken as the name the bracket explains.
 */
function statedAlias(name) {
  const m = /^([^()]+)\(([^()]+)\)\s*$/.exec(String(name ?? ''));
  if (!m) return null;
  const outer = m[1].split('/')[0].trim();
  return outer && m[2].trim() ? { name: outer, alias: m[2].trim() } : null;
}

/** Learn from fork entities ({name, aliases, events}). Replaces what was learned before. */
export function learnForkNames(forks = []) {
  const next = new Map();
  const display = new Map();
  // Best-attested entities first, so a name claimed by two entities follows the stronger one.
  // Each entity contributes its same-activation aliases and any alias its names state.
  const groups = forks.filter((f) => f?.name)
    .sort((a, b) => (b.events?.length ?? 0) - (a.events?.length ?? 0))
    .flatMap((f) => {
      const out = f.aliases?.length ? [{ name: f.name, aliases: f.aliases }] : [];
      for (const n of [f.name, ...(f.aliases ?? [])]) {
        const stated = statedAlias(n);
        if (stated) out.push({ name: stated.name, aliases: [stated.alias, n] });
      }
      return out;
    });
  for (const group of groups) {
    const canonical = forkIdentity(group.name);
    if (!canonical) continue;
    // A name already resolving elsewhere stays there: chains of renames stay one hop.
    const root = next.get(canonical) ?? canonical;
    if (!display.has(root)) display.set(root, group.name);
    for (const alias of group.aliases) {
      const id = forkIdentity(alias);
      if (!id || id === root || next.has(id)) continue;
      next.set(id, root);
    }
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
