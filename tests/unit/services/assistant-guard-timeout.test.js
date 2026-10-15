import { afterEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ total: 720000, guard: 60000 }));
vi.mock('../../../config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ASSISTANT_TOPIC_GUARD: true,
  ASSISTANT_LLM_URL: 'http://primary',
  ASSISTANT_MODEL: 'primary-model',
  ASSISTANT_FALLBACK_LLM_URL: 'http://backup',
  ASSISTANT_FALLBACK_MODEL: 'backup-model',
  get ASSISTANT_TIMEOUT_MS() { return settings.total; },
  get ASSISTANT_GUARD_TIMEOUT_MS() { return settings.guard; }
}));
vi.mock('../../../mcp-tools.js', () => ({
  getToolDefinitions: vi.fn(() => []), handleToolCall: vi.fn()
}));
import { runAssistant } from '../../../src/services/assistant.js';

const messages = [{ role: 'user', content: 'What is the chain ID of Ethereum mainnet?' }];
const log = { info() {}, warn() {} };
const response = (content) => ({ ok: true, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }) });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); settings.total = 720000; settings.guard = 60000; });

describe('bounded topic guard budget', () => {
  it('lets a 20s primary guard finish without prematurely switching providers', async () => {
    vi.useFakeTimers();
    const timeouts = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    const fetchImpl = vi.fn(async (_url, { signal }) => {
      if (fetchImpl.mock.calls.length === 1) {
        await new Promise((resolve, reject) => {
          setTimeout(resolve, 20000);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return response('yes');
      }
      return response('Ethereum mainnet is 1.');
    });
    const turn = runAssistant({ messages, log, fetchImpl });
    await vi.advanceTimersByTimeAsync(20000);
    const result = await turn;
    expect(timeouts.mock.calls[0][0]).toBe(60000);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'http://primary/v1/chat/completions', 'http://primary/v1/chat/completions'
    ]);
    expect(result.viaFallback).toBeFalsy();
  });

  it('honours an explicitly configured guard cap', async () => {
    settings.guard = 45000;
    const timeouts = vi.spyOn(AbortSignal, 'timeout');
    await runAssistant({ messages, log, fetchImpl: vi.fn(async () => response('no')) });
    expect(timeouts.mock.calls[0][0]).toBe(45000);
  });

  it.each([[10000, 6000], [500, 300], [1, 1]])('reserves the main loop within a %ims total budget', async (total, expected) => {
    settings.total = total;
    vi.spyOn(Date, 'now').mockReturnValue(100000);
    const timeouts = vi.spyOn(AbortSignal, 'timeout');
    const result = await runAssistant({ messages, log, fetchImpl: vi.fn(async () => response('no')) });
    expect(timeouts.mock.calls[0][0]).toBe(expected);
    expect(result.offTopic).toBe(true);
  });

  it('aborts a black-holed classifier at its cap and completes on fallback', async () => {
    vi.useFakeTimers();
    settings.guard = 45000;
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    const fetchImpl = vi.fn(async (_url, { signal }) => {
      if (fetchImpl.mock.calls.length === 1) {
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      return response('answer');
    });
    const turn = runAssistant({ messages, log, fetchImpl });
    await vi.advanceTimersByTimeAsync(44999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await turn).viaFallback).toBe(true);
    expect(fetchImpl.mock.calls[1][0]).toBe('http://backup/v1/chat/completions');
  });

  it('retains bounded failure fallback and does not disable classification', async () => {
    const fetchImpl = vi.fn(async () => {
      if (fetchImpl.mock.calls.length === 1) throw new DOMException('timed out', 'TimeoutError');
      return response('Ethereum mainnet is 1.');
    });
    const result = await runAssistant({ messages, log, fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).messages[0].content).toContain('strict topic classifier');
    expect(fetchImpl.mock.calls[1][0]).toBe('http://backup/v1/chat/completions');
    expect(result.viaFallback).toBe(true);
  });
});
