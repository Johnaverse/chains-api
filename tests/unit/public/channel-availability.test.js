import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the actual browser render functions without booting the unrelated dashboard
// data feeds. el's lightweight DOM facade retains text, attributes and click behavior.
const app = readFileSync(new URL('../../../public/app.js', import.meta.url), 'utf8');
const channelCode = app.slice(app.indexOf('const CHANNEL_PLATFORM_TEXT'), app.indexOf('// `research.hardware`'));
function element(tag, attrs = {}, children = []) {
  const classes = new Set((attrs.class || '').split(' '));
  return { tag, attrs, children, textContent: attrs.text || '',
    classList: { contains: name => classes.has(name), toggle: name => { if (classes.has(name)) { classes.delete(name); return false; } classes.add(name); return true; } },
    setAttribute(name, value) { this.attrs[name] = value; },
    appendChild(child) { this.children.push(child); },
    scrollIntoView() {}
  };
}
const context = vm.createContext({ URL, el: element, safeUrl: url => /^https?:/.test(url) ? url : null, safeHost: url => new URL(url).host, FORUM_SCOPE_TEXT: { project_family: 'project-wide', historical_network: 'historical network' }, evidenceLinks: record => (record.evidence || []).map(url => element('a', { href: url, text: 'source' })), detailRow: (label, node) => element('section', { text: label }, [node]) });
vm.runInContext(channelCode, context);
const { channelAvailability, channelItem, renderChannels } = context;
const all = node => [node, ...(node.children || []).flatMap(all)];
const text = node => all(node).map(n => n.textContent).filter(Boolean).join(' ');
const dataset = JSON.parse(readFileSync(new URL('../../../data/channel-research.json', import.meta.url), 'utf8'));
const channel = (id, url) => dataset.networks.find(n => n.chainId === id).channels.find(c => c.url === url);
const vaulta = channel(17777, 'https://bit.ly/VaultaTG');
const centrifuge = channel(2031, 'https://t.me/centrifuge_chat');
const discord = channel(2031, 'https://discord.com/invite/yEzyUq5gxF');

function badge(node) { return all(node).find(n => n.attrs.class === 'r-inactive'); }

describe('channel availability evidence and rendering', () => {
  it('uses the accessible critical-text token and a visible keyboard focus rule', () => {
    const css = readFileSync(new URL('../../../public/style.css', import.meta.url), 'utf8');
    expect(css.match(/\.r-inactive\s*\{[^}]+\}/)[0]).toContain('color: var(--critical-text)');
    expect(css).toMatch(/\.r-channel-details summary:focus-visible\s*\{[^}]*outline:/);
  });

  it('keeps Vaulta Inactive despite the later failed canonical URL lookup', () => {
    expect(vaulta.current_availability_checks.map(c => c.status)).toEqual(['removed_or_closed_explicit', 'unable_to_verify']);
    const result = channelAvailability(vaulta);
    expect(result.inactive).toBe(true);
    expect(result.text).toContain('2026-10-11 15:55:22 UTC');
    expect(result.text).toContain('Cached content possible; current status not rechecked');
    expect(result.text).toContain('Later retrieval was unverified');
    expect(badge(channelItem(vaulta)).textContent).toBe('Inactive');
    const reordered = { ...vaulta, current_availability_checks: [...vaulta.current_availability_checks].reverse() };
    expect(channelAvailability(reordered)).toEqual(result);
  });

  it('marks explicitly deprecated Centrifuge Telegram Inactive, not its inaccessible Discord', () => {
    expect(badge(channelItem(centrifuge)).textContent).toBe('Inactive');
    expect(channelAvailability(centrifuge).text).toContain('2026-10-11 15:54:48 UTC');
    const row = channelItem(discord);
    expect(badge(row)).toBeUndefined(); expect(text(row)).toContain('Availability unverified');
    expect(text(row)).toContain('not evidence that the channel is expired');
  });

  it('does not label Zeniq inactive from historical cached suspension evidence', () => {
    const zeniq = channel(383414847825, 'https://twitter.com/Zeniq_corp');
    expect(zeniq.current_availability_checks[0].observed_historical_status).toBe('removed_or_closed_explicit');
    expect(channelAvailability(zeniq).inactive).toBe(false);
    expect(badge(channelItem(zeniq))).toBeUndefined();
    expect(text(channelItem(zeniq))).toContain('9 months');
    expect(text(channelItem(zeniq))).toContain('Historical closure evidence only; current status unverified.');
  });

  it.each(['unable_to_verify', 'reachable_landing_only', 'accessible_public_preview', 'accessible_public_content', 'login_required', 'non_web_contact'])('never infers inactive or active from %s', status => {
    const c = { ...discord, current_availability_checks: [{ status, checked_at_utc: '2026-10-11T15:00:00Z', activity_status: 'unknown' }] };
    expect(channelAvailability(c).inactive).toBe(false); expect(badge(channelItem(c))).toBeUndefined();
    expect(text(channelItem(c))).not.toMatch(/\bActive\b/);
  });

  it('uses unknown for missing checks and missing dates, not an epoch or fresh claim', () => {
    expect(channelAvailability({}).text).toContain('unverified; no availability check recorded');
    const result = channelAvailability({ current_availability_checks: [{ status: 'unable_to_verify', checked_at_utc: null }] });
    expect(result.text).toContain('date unknown'); expect(result.text).not.toContain('1970');
  });

  it('exposes original notes, separate check evidence and freshness caveats in accessible details', () => {
    const row = channelItem(vaulta);
    expect(row.attrs.title).toBeUndefined();
    const details = all(row).find(n => n.tag === 'details');
    expect(details.children[0].tag).toBe('summary');
    expect(details.children[0].textContent).toBe('Availability evidence and notes');
    expect(text(details)).toContain(vaulta.notes);
    expect(text(details)).toContain('crawled last month');
    expect(text(details)).toContain('2026-10-11 15:55:35 UTC');
    expect(text(details)).toContain(vaulta.independent_verification.notes);
    expect(all(details).some(n => n.tag === 'a' && n.attrs.href === 'https://t.me/EOS_global')).toBe(true);
    // The date/freshness caveat sits outside the collapsible details and is always visible.
    expect(row.children.find(n => n.attrs.class === 'r-availability r-note').textContent).toContain('Cached content possible');
  });

  it('keeps notes and badges when Show more is expanded, collapsed and expanded again', () => {
    const section = element('section');
    renderChannels([...Array.from({ length: 8 }, () => discord), vaulta], section);
    const button = all(section).find(n => n.tag === 'button');
    const extra = all(section).find(n => n.attrs.class === 'rpc-list hidden');
    expect(extra.classList.contains('hidden')).toBe(true);
    for (const expanded of [true, false, true]) {
      button.attrs.onclick();
      expect(button.attrs['aria-expanded']).toBe(String(expanded));
      expect(extra.classList.contains('hidden')).toBe(!expanded);
      expect(badge(extra).textContent).toBe('Inactive');
      expect(text(extra)).toContain('crawled last month');
    }
  });
});
