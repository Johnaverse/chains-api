import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { recycleConnectionPools, startConnectionPoolRecycler, stopConnectionPoolRecycler } from '../../../src/transport/connectionPools.js';

const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');

describe('fetch connection pool recycler', () => {
  let saved;
  beforeEach(() => { saved = globalThis[GLOBAL_DISPATCHER]; });
  afterEach(() => { stopConnectionPoolRecycler(); globalThis[GLOBAL_DISPATCHER] = saved; vi.useRealTimers(); });

  it('replaces the agent with a fresh one of the same class and closes the old one', async () => {
    class Agent { constructor() { this.close = vi.fn().mockResolvedValue(); } }
    const old = new Agent();
    globalThis[GLOBAL_DISPATCHER] = old;
    expect(await recycleConnectionPools()).toBe(true);
    expect(globalThis[GLOBAL_DISPATCHER]).toBeInstanceOf(Agent);
    expect(globalThis[GLOBAL_DISPATCHER]).not.toBe(old);
    expect(old.close).toHaveBeenCalledOnce();
  });

  it('does nothing before the first request has created an agent', async () => {
    globalThis[GLOBAL_DISPATCHER] = undefined;
    expect(await recycleConnectionPools()).toBe(false);
    expect(globalThis[GLOBAL_DISPATCHER]).toBeUndefined();
  });

  it('leaves a configured agent of another class in place', async () => {
    class ProxyAgent { constructor() { this.close = vi.fn(); } }
    const proxy = new ProxyAgent();
    globalThis[GLOBAL_DISPATCHER] = proxy;
    expect(await recycleConnectionPools()).toBe(false);
    expect(globalThis[GLOBAL_DISPATCHER]).toBe(proxy);
    expect(proxy.close).not.toHaveBeenCalled();
  });

  it('still replaces the agent when closing the old one fails', async () => {
    class Agent { constructor() { this.close = vi.fn().mockRejectedValue(new Error('boom')); } }
    const old = new Agent();
    globalThis[GLOBAL_DISPATCHER] = old;
    expect(await recycleConnectionPools()).toBe(true);
    expect(globalThis[GLOBAL_DISPATCHER]).not.toBe(old);
  });

  it('recycles on the configured interval once started', async () => {
    vi.useFakeTimers();
    class Agent { constructor() { this.close = vi.fn().mockResolvedValue(); } }
    const old = new Agent();
    globalThis[GLOBAL_DISPATCHER] = old;
    startConnectionPoolRecycler();
    await vi.advanceTimersByTimeAsync(600000);
    expect(old.close).toHaveBeenCalledOnce();
    expect(globalThis[GLOBAL_DISPATCHER]).not.toBe(old);
  });

  it('keeps real requests working across a recycle, including one in flight', async () => {
    let release;
    const server = http.createServer((req, res) => {
      if (req.url === '/slow') { release = () => res.end('slow'); return; }
      res.end('ok');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      expect(await (await fetch(`${base}/`)).text()).toBe('ok');
      const slow = fetch(`${base}/slow`).then((r) => r.text());
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      const recycled = recycleConnectionPools();
      expect(await (await fetch(`${base}/`)).text()).toBe('ok');
      release();
      expect(await slow).toBe('slow');
      expect(await recycled).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
