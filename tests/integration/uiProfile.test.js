import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../index.js';

// The real public/index.html, so no file-system mock here.
describe('GET /ui/chains/:id', () => {
  let app;
  beforeAll(async () => { app = await buildApp({ logger: false, loadDataOnStartup: false }); });
  afterAll(async () => { await app.close(); });

  it('serves the dashboard with a base at /ui/, so a profile path loads the app', async () => {
    const response = await app.inject({ method: 'GET', url: '/ui/chains/1' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.payload).toMatch(/<head>\s*<base href="\/ui\/">/);
    expect(response.payload).toContain('profile.js');
    expect(response.headers['content-security-policy']).toContain("base-uri 'self'");
    const slash = await app.inject({ method: 'GET', url: '/ui/chains/1/' });
    expect(slash.statusCode).toBe(200);
    expect(slash.payload).toContain('<base href="/ui/">');
  });

  it('answers 400 for an id that is not a number', async () => {
    expect((await app.inject({ method: 'GET', url: '/ui/chains/abc' })).statusCode).toBe(400);
  });
});
