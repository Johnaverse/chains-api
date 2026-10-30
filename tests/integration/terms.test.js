import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../index.js';

describe('terms of use', () => {
  let app;
  beforeAll(async () => { app = await buildApp({ logger: false, loadDataOnStartup: false }); });
  afterAll(async () => { await app.close(); });

  it('robots.txt allows search on the pages, reserves AI use, and names the terms and the licence contact', async () => {
    const res = await app.inject({ url: '/robots.txt' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.payload).toContain('Content-Signal: search=yes, ai-input=no, ai-train=no');
    expect(res.payload).toMatch(/Allow: \/ui\/\nAllow: \/docs\nAllow: \/terms\nDisallow: \//);
    expect(res.payload).toContain('# Terms of use: https://chains-api.johnaverse.cc/terms');
    expect(res.payload).toContain('licensing@johnaverse.cc');
  });

  it('reserves text and data mining, pointing at the terms', async () => {
    const res = await app.inject({ url: '/.well-known/tdmrep.json' });
    expect(res.json()).toEqual([{ location: '/', 'tdm-reservation': 1, 'tdm-policy': 'https://chains-api.johnaverse.cc/terms' }]);
  });

  it('sends /terms to the terms page and links the terms from every response', async () => {
    const terms = await app.inject({ url: '/terms' });
    expect(terms.statusCode).toBe(302);
    expect(terms.headers.location).toBe('/ui/terms.html');
    const page = await app.inject({ url: '/ui/terms.html' });
    expect(page.statusCode).toBe(200);
    expect(page.payload).toContain('Commercial use requires a licence');
    for (const url of ['/', '/health', '/nope']) {
      const res = await app.inject({ url });
      expect(res.headers.link, url).toBe('<https://chains-api.johnaverse.cc/terms>; rel="license"');
      expect(res.headers['tdm-reservation'], url).toBe('1');
    }
  });

  it('names the terms and the licensing contact in the API index', async () => {
    const body = (await app.inject({ url: '/' })).json();
    expect(body).toMatchObject({ terms: 'https://chains-api.johnaverse.cc/terms', commercialLicensing: 'licensing@johnaverse.cc' });
  });
});
