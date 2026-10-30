import { TERMS_URL, LICENSING_CONTACT } from '../../../config.js';

/**
 * The service's terms, where machines look for them:
 *   /terms                    the terms page (public/terms.html, served under /ui/);
 *   /robots.txt               crawl rules and content signals: search indexing yes, AI training and
 *                             AI input no (Cloudflare prepends its managed content-signal notice);
 *   /.well-known/tdmrep.json  the EU text-and-data-mining reservation (TDMRep), pointing at the terms.
 * Every response also carries a `Link: <terms>; rel="license"` header (app.js).
 */
export function robotsTxt() {
  return [
    `# Terms of use: ${TERMS_URL}`,
    '# Free for personal and hobby use, academic research and teaching, and non-profit or',
    '# open-source projects that earn nothing from it. Any commercial or for-profit use,',
    `# including any use that earns revenue, requires a licence: ${LICENSING_CONTACT}`,
    '',
    'User-agent: *',
    'Content-Signal: search=yes, ai-input=no, ai-train=no',
    // The dashboard, its chain profiles, the API reference and the terms are for people and
    // search; the JSON endpoints, MCP and the assistant are not crawl targets.
    'Allow: /ui/',
    'Allow: /docs',
    'Allow: /terms',
    'Disallow: /',
    ''
  ].join('\n');
}

export function tdmRep() {
  return [{ location: '/', 'tdm-reservation': 1, 'tdm-policy': TERMS_URL }];
}

export async function termsRoutes(fastify) {
  const hidden = { schema: { hide: true } };
  fastify.get('/robots.txt', hidden, async (_request, reply) =>
    reply.type('text/plain; charset=utf-8').header('cache-control', 'public, max-age=3600').send(robotsTxt()));
  fastify.get('/.well-known/tdmrep.json', hidden, async (_request, reply) =>
    reply.header('cache-control', 'public, max-age=3600').send(tdmRep()));
  fastify.get('/terms', hidden, async (_request, reply) => reply.redirect('/ui/terms.html'));
}
