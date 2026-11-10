import { describe, it, expect, vi, afterEach } from 'vitest';

const KEYS = ['X402_ENABLED', 'X402_PAY_TO', 'X402_NETWORK', 'X402_PRICE_USD', 'X402_FACILITATOR_URL', 'X402_DOMAINS', 'X402_RPC_URLS', 'PUBLIC_ORIGIN'];
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));

async function load(env) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  vi.resetModules();
  return import('../../config.js');
}

afterEach(() => {
  for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  vi.restoreAllMocks();
});

describe('x402 config', () => {
  it('is off by default', async () => {
    const config = await load({});
    expect(config.X402_ENABLED).toBe(false);
    expect(config.X402).toEqual({});
  });

  it('defaults to Base Sepolia and the x402.org facilitator', async () => {
    const config = await load({ X402_ENABLED: 'true', X402_PAY_TO: '0x000000000000000000000000000000000000dEaD' });
    expect(config.X402).toEqual({ payTo: '0x000000000000000000000000000000000000dEaD', network: 'eip155:84532', priceUsd: 0.001, facilitatorUrl: 'https://x402.org/facilitator', domains: [], rpcUrls: [] });
  });

  it('charges only the public origin\'s host unless X402_DOMAINS says otherwise', async () => {
    const env = { X402_ENABLED: 'true', X402_PAY_TO: '0x000000000000000000000000000000000000dEaD', PUBLIC_ORIGIN: 'https://chains-api.johnaverse.cc' };
    expect((await load(env)).X402.domains).toEqual(['chains-api.johnaverse.cc']);
    expect((await load({ ...env, X402_DOMAINS: ' Chains-API.johnaverse.cc, mcp.example.com. ' })).X402.domains).toEqual(['chains-api.johnaverse.cc', 'mcp.example.com']);
  });

  it('checks payments on-chain through the trusted RPC endpoints given, else the registry\'s', async () => {
    const env = { X402_ENABLED: 'true', X402_PAY_TO: '0x000000000000000000000000000000000000dEaD' };
    expect((await load(env)).X402.rpcUrls).toEqual([]);
    expect((await load({ ...env, X402_RPC_URLS: ' https://a.example.com , http://node.chains.svc:8545 ' })).X402.rpcUrls).toEqual(['https://a.example.com', 'http://node.chains.svc:8545']);
  });

  it('stops the process on a setting it cannot use', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const env of [
      { X402_PAY_TO: '' },
      { X402_PAY_TO: '0x000000000000000000000000000000000000dEaD', X402_NETWORK: 'base' },
      { X402_PAY_TO: '0x000000000000000000000000000000000000dEaD', X402_PRICE_USD: '0' },
      { X402_PAY_TO: '0x000000000000000000000000000000000000dEaD', X402_PRICE_USD: '0.0000001' },
      { X402_PAY_TO: '0x000000000000000000000000000000000000dEaD', X402_NETWORK: 'cosmos:cosmoshub-4' },
      { X402_PAY_TO: '0x000000000000000000000000000000000000dEaD', X402_NETWORK: 'eip155:abc' },
      { X402_PAY_TO: '0x000000000000000000000000000000000000dEaD', X402_FACILITATOR_URL: 'http://facilitator.test' },
      { X402_PAY_TO: '0x000000000000000000000000000000000000dEaD', X402_DOMAINS: 'https://chains-api.johnaverse.cc' },
      { X402_PAY_TO: '0x000000000000000000000000000000000000dEaD', X402_DOMAINS: 'chains-api.johnaverse.cc:443' },
      { X402_PAY_TO: '0x000000000000000000000000000000000000dEaD', X402_RPC_URLS: 'https://base-sepolia.example.com' },
      { X402_PAY_TO: '0x000000000000000000000000000000000000dEaD', X402_RPC_URLS: 'https://a.example.com, wss://b.example.com' }
    ]) {
      await expect(load({ X402_ENABLED: 'true', ...env })).rejects.toThrow('exit');
    }
    expect(exit).toHaveBeenCalledTimes(11);
  });
});
