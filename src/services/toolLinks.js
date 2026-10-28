/**
 * Links in the assistant's answers (OWASP LLM01/LLM06): which ones a tool result vouches for, and
 * which the answer may carry. Shared by the tool adapter (assistantTools.js, which reads a result's
 * link fields before truncation) and the loop (assistant.js).
 */

const TRAILING = new Set(['.', ',', ';', ':', '!', '?', "'", '"']);
// Trailing punctuation goes back to the text, as on the dashboard. A loop, not /[…]+$/, which is
// quadratic on a long run of punctuation.
function trimUrl(token) {
  let end = token.length;
  while (end > 0 && TRAILING.has(token[end - 1])) end--;
  return token.slice(0, end);
}

// Fields whose value IS a link (a URL field, or a list of them): `url`, `infoURL`, `sourceUrl`,
// `href`, `link`, `website`, `homepage`; research citations (`sources`, `evidence` — hardware
// profiles, dependencies, research items); endpoint lists (`rpc`, `firehose`, `substreams`). A
// URL-shaped `summary` or `title` is free text a source wrote, so it is not one. Only a value that
// is wholly a URL is taken, whatever the field.
const LINK_FIELD = /(?:^|[_-])(?:urls?|uris?|hrefs?|links?|website|homepage|sources|evidence|rpc|firehose|substreams)$|(?:Url|URL|Uri)s?$/i;

/**
 * The http(s) URLs a tool result gives in its link fields — an incident's `url`, a chain's
 * `infoURL`, an explorer's `url` — never ones in free text (a post's body, a status summary),
 * where a planted link would sit. Results that are not JSON give none.
 */
export function fieldLinks(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const out = [];
  const take = (v) => {
    if (typeof v === 'string' && /^https?:\/\/\S+$/.test(v.trim())) out.push(trimForCheck(v.trim()));
    else if (Array.isArray(v)) v.forEach(take);
  };
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [key, value] of Object.entries(v)) {
        if (LINK_FIELD.test(key)) take(value);
        walk(value);
      }
    }
  };
  walk(doc);
  return out;
}

// Every run the dashboard could make a link of: its URL pattern (public/app.js INLINE_MD) without
// the code/bold alternatives — a link never extends past such a run.
const LINK_RUNS = /https?:\/\/[^\s<)]+/g;
// Also cut when checking: a URL ending in a code or bold span's closing mark is that URL.
const CHECK_TRAILING = new Set([...TRAILING, '`', '*']);
function trimForCheck(token) {
  let end = token.length;
  while (end > 0 && CHECK_TRAILING.has(token[end - 1])) end--;
  return token.slice(0, end);
}

/**
 * The answer with only links it may carry: those a tool result gave in a link field, or the user
 * wrote. The dashboard turns bare URLs into links, so a phishing link a planted forum post talked
 * the model into repeating would otherwise reach the reader clickable (OWASP LLM01/LLM06).
 *
 * Not a mirror of the renderer — every mismatch with it was a way through. Each maximal run is
 * checked as every destination it could become: the whole run (prose), and the run cut at each
 * `|` (a table cell); code and bold spans make no shorter link, only none. A run is kept only when
 * every one is trusted; otherwise it becomes its host, "(link not from a source)", with no scheme
 * left for the dashboard to link.
 */
/** The links the user wrote, as the check compares them. */
export const linksIn = (text) => (String(text).match(LINK_RUNS) ?? []).map((raw) => trimForCheck(trimUrl(raw)));

export function limitLinks(text, trusted) {
  return String(text).replace(LINK_RUNS, (raw) => {
    const url = trimUrl(raw);
    const tail = raw.slice(url.length);
    const candidates = [trimForCheck(url)];
    for (let i = raw.indexOf('|'); i !== -1; i = raw.indexOf('|', i + 1)) candidates.push(trimForCheck(raw.slice(0, i)));
    const destinations = candidates.filter((c) => /^https?:\/\/./.test(c));
    if (destinations.every((c) => trusted.has(c))) return raw;
    // A code or bold span's closing mark stays right after the host, so the span still closes.
    const checked = trimForCheck(url);
    const marks = url.slice(checked.length);
    let host = null;
    try { host = new URL(checked).host; } catch { /* not a URL */ }
    return `${host ?? 'a link'}${marks} (link not from a source)${tail}`;
  });
}
