import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { recycleConnectionPools, startConnectionPoolRecycler, stopConnectionPoolRecycler, _resetConnectionPoolsForTests } from '../../../src/transport/connectionPools.js';

const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');

describe('fetch connection pool recycler', () => {
  // Each test gets its own real agent, so closing one never touches the agent other files use.
  let saved;
  beforeEach(async () => {
    await fetch('http://127.0.0.1:1/').catch(() => {}); // the first request creates the agent
    saved = globalThis[GLOBAL_DISPATCHER];
    globalThis[GLOBAL_DISPATCHER] = new saved.constructor();
  });
  afterEach(() => { _resetConnectionPoolsForTests(); globalThis[GLOBAL_DISPATCHER] = saved; vi.useRealTimers(); });

  it('replaces the agent with a fresh one of the same class and closes the old one a round later', async () => {
    class Agent { constructor() { this.close = vi.fn().mockResolvedValue(); this.destroy = vi.fn().mockResolvedValue(); } }
    const first = new Agent();
    globalThis[GLOBAL_DISPATCHER] = first;
    expect(await recycleConnectionPools()).toBe(true);
    const second = globalThis[GLOBAL_DISPATCHER];
    expect(second).toBeInstanceOf(Agent);
    expect(second).not.toBe(first);
    // Still open: a fetch that started on it may have a redirect hop to make.
    expect(first.close).not.toHaveBeenCalled();
    expect(await recycleConnectionPools()).toBe(true);
    await vi.waitFor(() => expect(first.close).toHaveBeenCalledOnce());
    expect(first.destroy).not.toHaveBeenCalled();
    expect(second.close).not.toHaveBeenCalled();
  });

  it('destroys an agent a round after closing it, so an unfinished response cannot keep it', async () => {
    class Agent { constructor() { this.close = vi.fn(() => new Promise(() => {})); this.destroy = vi.fn().mockResolvedValue(); } }
    const first = new Agent();
    globalThis[GLOBAL_DISPATCHER] = first;
    await recycleConnectionPools();
    await recycleConnectionPools();
    await vi.waitFor(() => expect(first.close).toHaveBeenCalledOnce());
    expect(first.destroy).not.toHaveBeenCalled();
    expect(await recycleConnectionPools()).toBe(true);
    await vi.waitFor(() => expect(first.destroy).toHaveBeenCalledOnce());
  });

  it('closes the retired agent when the recycler is stopped', async () => {
    class Agent { constructor() { this.close = vi.fn().mockResolvedValue(); this.destroy = vi.fn().mockResolvedValue(); } }
    const first = new Agent();
    globalThis[GLOBAL_DISPATCHER] = first;
    await recycleConnectionPools();
    stopConnectionPoolRecycler();
    await vi.waitFor(() => expect(first.close).toHaveBeenCalledOnce());
    expect(globalThis[GLOBAL_DISPATCHER].close).not.toHaveBeenCalled();
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

  it('still replaces the agent when closing a retired one fails', async () => {
    class Agent { constructor() { this.close = vi.fn().mockRejectedValue(new Error('boom')); this.destroy = vi.fn().mockResolvedValue(); } }
    const first = new Agent();
    globalThis[GLOBAL_DISPATCHER] = first;
    await recycleConnectionPools();
    const second = globalThis[GLOBAL_DISPATCHER];
    expect(await recycleConnectionPools()).toBe(true);
    await vi.waitFor(() => expect(first.close).toHaveBeenCalledOnce());
    expect(globalThis[GLOBAL_DISPATCHER]).not.toBe(second);
  });

  it('recycles on the configured interval once started', async () => {
    vi.useFakeTimers();
    class Agent { constructor() { this.close = vi.fn().mockResolvedValue(); this.destroy = vi.fn().mockResolvedValue(); } }
    const old = new Agent();
    globalThis[GLOBAL_DISPATCHER] = old;
    startConnectionPoolRecycler();
    await vi.advanceTimersByTimeAsync(600000);
    expect(globalThis[GLOBAL_DISPATCHER]).not.toBe(old);
    expect(old.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600000);
    expect(old.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(600000);
    expect(old.destroy).toHaveBeenCalledOnce();
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

  it('follows a redirect that arrives after the agent was replaced', async () => {
    let release;
    const target = http.createServer((req, res) => res.end('landed'));
    await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
    const origin = http.createServer((req, res) => {
      if (req.url === '/warm') { res.end('ok'); return; }
      release = () => { res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/` }); res.end(); };
    });
    await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${origin.address().port}`;
    try {
      await (await fetch(`${base}/warm`)).text();
      const redirected = fetch(`${base}/go`).then((r) => r.text());
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      expect(await recycleConnectionPools()).toBe(true);
      release();
      expect(await redirected).toBe('landed');
    } finally {
      await new Promise((resolve) => origin.close(resolve));
      await new Promise((resolve) => target.close(resolve));
    }
  });
});
