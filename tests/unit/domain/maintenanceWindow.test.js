import { describe, it, expect } from 'vitest';
import { hasWindowBanner, windowEndMs } from '../../../src/domain/maintenanceWindow.js';

// The exact markup Atlassian status pages emit, <var> wrappers and all.
const banner = (body) => `<p><strong>THIS IS A SCHEDULED EVENT ${body}</strong></p> <p>details</p>`;

describe('hasWindowBanner', () => {
  it('detects the banner and ignores ordinary bodies', () => {
    expect(hasWindowBanner(banner('Aug 3, 14:00 - 18:00 UTC'))).toBe(true);
    expect(hasWindowBanner('<p>We are investigating elevated error rates.</p>')).toBe(false);
    expect(hasWindowBanner(null)).toBe(false);
  });
});

describe('windowEndMs', () => {
  const start = (iso) => Date.parse(iso);

  it('reads a same-day end time', () => {
    const s = start('2026-08-03T14:00:00.000Z');
    expect(windowEndMs(banner("Aug <var data-var='date'>3</var>, <var data-var='time'>14:00</var> - <var data-var='time'>18:00</var> UTC"), s))
      .toBe(start('2026-08-03T18:00:00.000Z'));
  });

  it('reads an end that carries its own date', () => {
    const s = start('2026-07-27T18:35:00.000Z');
    expect(windowEndMs(banner('Jul 27, 18:35 UTC &nbsp;-&nbsp; Jul 28, 04:35 UTC'), s))
      .toBe(start('2026-07-28T04:35:00.000Z'));
  });

  it('rolls a bare end time past midnight rather than backwards', () => {
    const s = start('2026-08-03T22:00:00.000Z');
    expect(windowEndMs(banner('Aug 3, 22:00 - 02:00 UTC'), s)).toBe(start('2026-08-04T02:00:00.000Z'));
  });

  it('rolls the year when a dated window crosses new year', () => {
    const s = start('2026-12-31T23:00:00.000Z');
    expect(windowEndMs(banner('Dec 31, 23:00 UTC - Jan 1, 03:00 UTC'), s)).toBe(start('2027-01-01T03:00:00.000Z'));
  });

  it('strips nested tags that a single pass would reassemble', () => {
    // `<scr<a>ipt>` becomes `<script>` after one pass; the extraction loops
    // until stable so the banner text is reached whatever the body contains.
    const s = start('2026-08-03T14:00:00.000Z');
    const messy = `<p><scr<a>ipt>THIS IS A SCHEDULED EVENT Aug <var data-var='date'>3</var>, 14:00 - 18:00 UTC</p>`;
    expect(windowEndMs(messy, s)).toBe(start('2026-08-03T18:00:00.000Z'));
  });

  it('returns null rather than a guess for a missing banner, bad start or absurd span', () => {
    expect(windowEndMs('<p>no banner here</p>', start('2026-08-03T14:00:00.000Z'))).toBeNull();
    expect(windowEndMs(banner('Aug 3, 14:00 - 18:00 UTC'), null)).toBeNull();
    expect(windowEndMs(banner('Aug 3, 14:00 UTC - Dec 25, 18:00 UTC'), start('2026-08-03T14:00:00.000Z'))).toBeNull();
    expect(windowEndMs(banner('sometime next week'), start('2026-08-03T14:00:00.000Z'))).toBeNull();
  });
});
