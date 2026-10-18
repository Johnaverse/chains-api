/**
 * Planned work vs incident, decided once for every surface.
 *
 * The status alone used to decide it: a `maintenance_*` status was planned work, anything else
 * an incident. Providers do not hold to that: Chainstack posted "Scheduled protocol upgrade
 * (Polygon mainnet)" as `monitoring`, QuickNode closed "Ethereum - Sepolia/Hoodi - Upgrade to
 * Geth-v1.17.6 & Erigon v3.7.0" as `resolved`, and "Solana Mainnet - Alpenglow Regenesis" went
 * through `monitoring`. Of 500 live status events, 12 classed as a software update or fork
 * carried an incident status, and each one reached the Incidents list, the provider scorecard
 * and the chain-level correlation as an outage.
 *
 * The feed's classifier reads the text and says what the post is about, so a confident
 * software-update or fork class makes the post planned work whatever its status. An outage
 * during a window is published as its own entry with its own class and stays an incident; a
 * low-confidence class is not trusted to override the status.
 */

// The status-news, forum and news feeds share one taxonomy (chains-news/src/taxonomy.js); the
// status feed still emits its legacy names for older records.
export const PLANNED_WORK_CLASSES = new Set([
  'planned_hard_fork',
  'planned_software_update',
  // A fix shipped in a hurry is still a software update operators roll out — the incident it
  // answers, if any, is its own entry.
  'urgent_software_fix',
  'scheduled_maintenance',
  // Legacy status-news names.
  'hard_fork',
  'software_update'
]);

export const MAINTENANCE_STATUSES = new Set(['maintenance_scheduled', 'maintenance_in_progress', 'maintenance_completed']);

/** Whether an enrichment confidently classes its item as planned work. */
export function isPlannedClass(enrichment) {
  if (!enrichment || enrichment.lowConfidence === true) return false;
  return PLANNED_WORK_CLASSES.has(enrichment.class);
}

/** Whether one status event is planned work: by its status, or by its confident class. */
export function isPlannedEvent(event) {
  return MAINTENANCE_STATUSES.has(event?.status) || isPlannedClass(event?.enrichment);
}

/**
 * Whether a group of updates of one entry (see groupEventsByIncident) is planned work.
 *
 * The newest maintenance status, or the newest confident classification across the updates:
 * the classifier often runs on only some of an entry's updates, and the update that moved a
 * window to `resolved` is rarely the one it read.
 */
export function isPlannedGroup(group) {
  if (MAINTENANCE_STATUSES.has(group?.latest?.status)) return true;
  const updates = group?.updates ?? [];
  for (let i = updates.length - 1; i >= 0; i -= 1) {
    const enrichment = updates[i]?.enrichment;
    if (!enrichment?.class || enrichment.lowConfidence === true) continue;
    return PLANNED_WORK_CLASSES.has(enrichment.class);
  }
  return false;
}
