/**
 * Scheduled-maintenance window extraction.
 *
 * Atlassian-hosted status pages (8 of the 10 RPC providers we track) prefix a
 * scheduled maintenance body with a banner naming the window:
 *
 *   THIS IS A SCHEDULED EVENT Aug 3, 14:00 - 18:00 UTC          (same-day end)
 *   THIS IS A SCHEDULED EVENT Jul 27, 18:35 UTC - Jul 28, 04:35 UTC   (spans days)
 *
 * Two things matter here:
 *
 * 1. The banner's START always equals the entry's own publishedAt — verified
 *    across every marked entry in the live feed. That is what makes
 *    `publishedAt` of a marked entry the ACTIVATION time rather than the
 *    announcement time, and it is why the timeline needs `hasWindowBanner`:
 *    some providers (Hedera) emit window entries labelled `maintenance_completed`,
 *    so status alone can't identify them.
 * 2. The banner's END is the only place the window DURATION exists. Nothing
 *    else in the feed carries it.
 *
 * Everything degrades to null: a body with no banner, an unparseable date, or
 * a nonsensical duration yields no window rather than a guess.
 */

// Longest plausible maintenance window. Anything beyond this is a parse error
// (a year rolled the wrong way, a month abbreviation misread), not a real
// 6-week outage window — better to emit nothing than a bogus duration.
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

const BANNER = /THIS IS A SCHEDULED EVENT/i;
// "Jul 28, 04:35 UTC" — an end stamp carrying its own date (window spans days).
const DATED_END = /-\s*(?:&nbsp;)?\s*([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s*(\d{1,2}):(\d{2})\s*UTC/i;
// "14:00 - 18:00 UTC" — a bare end time, same calendar day as the start.
const BARE_END = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*UTC/;

/** True when this update's body is a scheduled-window entry (start == publishedAt). */
export function hasWindowBanner(summary) {
  return typeof summary === 'string' && BANNER.test(summary);
}

/**
 * Window end for an entry whose start is `startMs` (its publishedAt).
 *
 * @param {string|null|undefined} summary raw entry body (HTML tolerated)
 * @param {number|null} startMs the entry's publishedAt in epoch ms
 * @returns {number|null} epoch ms of the window end, or null when unknown
 */
export function windowEndMs(summary, startMs) {
  if (!hasWindowBanner(summary) || !Number.isFinite(startMs)) return null;
  // Strip the <var data-var='date'>5</var> wrappers Atlassian injects so the
  // banner reads as the plain text the regexes above expect.
  const text = String(summary).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
  const banner = text.slice(text.search(BANNER), text.search(BANNER) + 160);
  const start = new Date(startMs);

  const dated = banner.match(DATED_END);
  if (dated) {
    const month = MONTHS[dated[1].toLowerCase()];
    if (month == null) return null;
    let end = Date.UTC(start.getUTCFullYear(), month, Number(dated[2]), Number(dated[3]), Number(dated[4]));
    // A Dec 31 -> Jan 1 window reads as an end eleven months BEFORE the start
    // when it inherits the start's year; rolling the year forward fixes it.
    if (end <= startMs) end = Date.UTC(start.getUTCFullYear() + 1, month, Number(dated[2]), Number(dated[3]), Number(dated[4]));
    return sane(end, startMs);
  }

  const bare = banner.match(BARE_END);
  if (bare) {
    let end = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), Number(bare[3]), Number(bare[4]));
    // "22:00 - 02:00 UTC" ends after midnight on the following day.
    if (end <= startMs) end += DAY_MS;
    return sane(end, startMs);
  }
  return null;
}

function sane(endMs, startMs) {
  return endMs > startMs && endMs - startMs <= MAX_WINDOW_MS ? endMs : null;
}
