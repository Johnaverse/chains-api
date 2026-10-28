/**
 * Links in the assistant's answers (OWASP LLM01/LLM06): which ones a tool result vouches for, and
 * which the answer may carry. Shared by the tool adapter (assistantTools.js, which reads a result's
 * link fields before truncation) and the loop (assistant.js).
 */

// The dashboard's own inline tokens (public/app.js INLINE_MD): a code span, bold, or a bare URL —
// only the last is made a link, so only it is checked, cut exactly as the dashboard cuts it.
const INLINE_TOKENS = /`([^`]+)`|\*\*([^*]+)\*\*|(https?:\/\/[^\s<)]+)/g;
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', "'", '"']);
// Trailing punctuation goes back to the text, as on the dashboard. A loop, not /[…]+$/, which is
// quadratic on a long run of punctuation.
function trimUrl(token) {
  let end = token.length;
  while (end > 0 && TRAILING.has(token[end - 1])) end--;
  return token.slice(0, end);
}
export const linksIn = (text) => [...String(text).matchAll(INLINE_TOKENS)].filter((m) => m[3] != null).map((m) => trimUrl(m[3]));

// Fields whose value IS a link (a URL field, or a list of them): `url`, `infoURL`, `sourceUrl`,
// `href`, `link`, `website`, `homepage`. A URL-shaped `summary` or `title` is free text a source
// wrote, so it is not one.
const LINK_FIELD = /(?:^|[_-])(?:urls?|uris?|hrefs?|links?|website|homepage)$|(?:Url|URL|Uri)s?$/i;

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
    if (typeof v === 'string' && /^https?:\/\/\S+$/.test(v.trim())) out.push(trimUrl(v.trim()));
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

/**
 * The answer with only links it may carry: those a tool result gave in a link field, or the user
 * wrote. The dashboard turns bare URLs into links, so a phishing link a planted forum post talked
 * the model into repeating would otherwise reach the reader clickable (OWASP LLM01/LLM06). Others
 * become their host, marked as such. Code and bold spans are left alone: the dashboard links
 * neither.
 */
export function limitLinks(text, trusted) {
  return String(text).replace(INLINE_TOKENS, (whole, code, bold, raw) => {
    if (raw == null) return whole;
    const url = trimUrl(raw);
    const tail = raw.slice(url.length);
    if (trusted.has(url)) return whole;
    let host = null;
    try { host = new URL(url).host; } catch { /* not a URL */ }
    return `${host ?? 'a link'} (link not from a source)${tail}`;
  });
}
