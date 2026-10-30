import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  assistantEnabled: false,
  runAssistant: vi.fn(),
  checkLlmReachable: vi.fn(async () => true)
}));

vi.mock('../../../config.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    get ASSISTANT_ENABLED() { return mocks.assistantEnabled; },
    ASSISTANT_MODEL: 'test-model',
    // Short sync window so async-path tests don't wait 8s
    ASSISTANT_SYNC_WAIT_MS: 100,
    ASSISTANT_MAX_CONCURRENT_JOBS: 2,
    // The whole file shares one inject IP — don't let earlier tests exhaust
    // the per-IP POST budget for later ones
    ASSISTANT_RATE_LIMIT_MAX: 1000
  };
});

vi.mock('../../../src/services/assistant.js', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, runAssistant: mocks.runAssistant, checkLlmReachable: mocks.checkLlmReachable };
});

import { buildApp } from '../../../index.js';
import { _resetAssistantJobsForTests } from '../../../src/http/routes/assistant.js';

function chatPayload(overrides = {}) {
  return { messages: [{ role: 'user', content: 'is base healthy?' }], ...overrides };
}

describe('assistant routes', () => {
  let app;

  beforeAll(async () => {
    app = await buildApp({ logger: false, loadDataOnStartup: false });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    mocks.assistantEnabled = false;
    mocks.runAssistant.mockReset();
    _resetAssistantJobsForTests();
  });

  describe('GET /assistant', () => {
    it('reports disabled with null model, reachability and timeout', async () => {
      const res = await app.inject({ method: 'GET', url: '/assistant' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ enabled: false, model: null, reachable: null, timeoutMs: null });
      expect(mocks.checkLlmReachable).not.toHaveBeenCalled();
    });

    it('reports enabled with the configured model, live reachability and effective timeout', async () => {
      mocks.assistantEnabled = true;
      const res = await app.inject({ method: 'GET', url: '/assistant' });
      expect(res.json()).toEqual({ enabled: true, model: 'test-model', reachable: true, timeoutMs: 60000 });

      mocks.checkLlmReachable.mockResolvedValueOnce(false);
      const down = await app.inject({ method: 'GET', url: '/assistant' });
      expect(down.json()).toEqual({ enabled: true, model: 'test-model', reachable: false, timeoutMs: 60000 });
    });
  });

  describe('POST /assistant/chat', () => {
    it('returns 503 when the assistant is not configured', async () => {
      const res = await app.inject({ method: 'POST', url: '/assistant/chat', payload: chatPayload() });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('Assistant not configured');
      expect(mocks.runAssistant).not.toHaveBeenCalled();
    });

    it('returns the assistant result on the happy path', async () => {
      mocks.assistantEnabled = true;
      mocks.runAssistant.mockResolvedValue({
        reply: 'Base mainnet (`8453`) is healthy.',
        toolCalls: [{ name: 'get_rpc_monitor_by_id', args: { chainId: 8453 } }],
        degraded: false,
        usage: { promptTokens: 10, completionTokens: 5 }
      });
      const res = await app.inject({
        method: 'POST',
        url: '/assistant/chat',
        payload: chatPayload({ context: { view: 'networks', chainId: 8453 } })
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.reply).toMatch(/8453/);
      expect(body.toolCalls[0].name).toBe('get_rpc_monitor_by_id');
      expect(mocks.runAssistant).toHaveBeenCalledWith(expect.objectContaining({
        messages: [{ role: 'user', content: 'is base healthy?' }],
        context: { view: 'networks', chainId: 8453 }
      }));
    });

    it('returns 503 when the LLM is unreachable', async () => {
      mocks.assistantEnabled = true;
      const { AssistantUnavailableError } = await import('../../../src/services/assistant.js');
      mocks.runAssistant.mockRejectedValue(new AssistantUnavailableError('ECONNREFUSED'));
      const res = await app.inject({ method: 'POST', url: '/assistant/chat', payload: chatPayload() });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('Assistant LLM unreachable');
    });

    it('rejects an empty messages array', async () => {
      mocks.assistantEnabled = true;
      const res = await app.inject({ method: 'POST', url: '/assistant/chat', payload: { messages: [] } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/At least one message/);
    });

    it('rejects a missing messages field', async () => {
      mocks.assistantEnabled = true;
      const res = await app.inject({ method: 'POST', url: '/assistant/chat', payload: {} });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/messages/);
    });

    it('rejects too many messages', async () => {
      mocks.assistantEnabled = true;
      const messages = Array.from({ length: 21 }, () => ({ role: 'user', content: 'hi' }));
      const res = await app.inject({ method: 'POST', url: '/assistant/chat', payload: { messages } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/Too many messages/);
    });

    it('rejects oversized message content', async () => {
      mocks.assistantEnabled = true;
      const res = await app.inject({
        method: 'POST',
        url: '/assistant/chat',
        payload: { messages: [{ role: 'user', content: 'x'.repeat(4001) }] }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/too long/i);
    });

    it('rejects invalid roles and unknown fields', async () => {
      mocks.assistantEnabled = true;
      const badRole = await app.inject({
        method: 'POST',
        url: '/assistant/chat',
        payload: { messages: [{ role: 'system', content: 'sneaky prompt injection' }] }
      });
      expect(badRole.statusCode).toBe(400);

      const extraField = await app.inject({
        method: 'POST',
        url: '/assistant/chat',
        payload: chatPayload({ surprise: true })
      });
      expect(extraField.statusCode).toBe(400);
    });

    it('rejects a conversation not ending with a user message', async () => {
      mocks.assistantEnabled = true;
      const res = await app.inject({
        method: 'POST',
        url: '/assistant/chat',
        payload: { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Last message must be from the user');
      expect(mocks.runAssistant).not.toHaveBeenCalled();
    });
  });

  describe('async job flow (slow LLM runs)', () => {
    function deferred() {
      let resolve, reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    }
    const RESULT = { reply: 'done!', toolCalls: [], degraded: false, usage: null };

    it('returns 202 with a jobId when the run outlives the sync window, then serves the result on poll', async () => {
      mocks.assistantEnabled = true;
      const d = deferred();
      let reportStep;
      mocks.runAssistant.mockImplementation(({ onStep }) => { reportStep = onStep; return d.promise; });

      const post = await app.inject({ method: 'POST', url: '/assistant/chat', payload: chatPayload() });
      expect(post.statusCode).toBe(202);
      const { jobId, status, pollAfterMs, budgetMs, steps } = post.json();
      expect(status).toBe('running');
      expect(pollAfterMs).toBeGreaterThan(0);
      expect(budgetMs).toBe(60000); // server declares its budget for the client's poll window
      expect(steps).toEqual([]); // trace field present from the first response
      expect(jobId).toMatch(/^[A-Za-z0-9-]+$/);

      // Still running — and the FULL harness step trace surfaces on the poll,
      // each step timestamped for duration display
      reportStep('thinking');
      reportStep('using search_chains');
      const pending = await app.inject({ method: 'GET', url: `/assistant/chat/${jobId}` });
      const body = pending.json();
      expect(body.status).toBe('running');
      expect(body.steps.map((s) => s.label)).toEqual(['thinking', 'using search_chains']);
      for (const s of body.steps) expect(s.at).toBeTypeOf('number');

      d.resolve(RESULT);
      await d.promise;
      const done = await app.inject({ method: 'GET', url: `/assistant/chat/${jobId}` });
      expect(done.statusCode).toBe(200);
      expect(done.json()).toMatchObject({ status: 'done', reply: 'done!' });
    });

    it('keeps the NEWEST steps at the cap so the current step stays truthful', async () => {
      mocks.assistantEnabled = true;
      const d = deferred();
      let reportStep;
      mocks.runAssistant.mockImplementation(({ onStep }) => { reportStep = onStep; return d.promise; });
      const post = await app.inject({ method: 'POST', url: '/assistant/chat', payload: chatPayload() });
      const { jobId } = post.json();

      for (let i = 1; i <= 45; i++) reportStep(`step ${i}`);
      const res = await app.inject({ method: 'GET', url: `/assistant/chat/${jobId}` });
      const labels = res.json().steps.map((s) => s.label);
      expect(labels).toHaveLength(40);
      expect(labels[0]).toBe('step 6');      // oldest five dropped
      expect(labels[39]).toBe('step 45');    // newest always last — the UI's "active" step
      d.resolve(RESULT);
    });

    it('reports errors through the job status', async () => {
      mocks.assistantEnabled = true;
      const d = deferred();
      mocks.runAssistant.mockReturnValue(d.promise);
      const post = await app.inject({ method: 'POST', url: '/assistant/chat', payload: chatPayload() });
      const { jobId } = post.json();
      const { AssistantUnavailableError } = await import('../../../src/services/assistant.js');
      d.reject(new AssistantUnavailableError('boom'));
      await d.promise.catch(() => {});
      const res = await app.inject({ method: 'GET', url: `/assistant/chat/${jobId}` });
      expect(res.json()).toMatchObject({ status: 'error', error: 'Assistant LLM unreachable' });
    });

    it('404s for unknown job ids and 400s for malformed ones', async () => {
      const missing = await app.inject({ method: 'GET', url: '/assistant/chat/00000000-0000-0000-0000-000000000000' });
      expect(missing.statusCode).toBe(404);
      const malformed = await app.inject({ method: 'GET', url: '/assistant/chat/nope_$$' });
      expect(malformed.statusCode).toBe(400);
    });

    it('rejects new chats when the concurrent job cap is reached', async () => {
      mocks.assistantEnabled = true;
      const d = deferred();
      mocks.runAssistant.mockReturnValue(d.promise);
      await app.inject({ method: 'POST', url: '/assistant/chat', payload: chatPayload() });
      await app.inject({ method: 'POST', url: '/assistant/chat', payload: chatPayload() });
      const third = await app.inject({ method: 'POST', url: '/assistant/chat', payload: chatPayload() });
      expect(third.statusCode).toBe(503);
      expect(third.json().error).toMatch(/busy/);
      d.resolve(RESULT);
    });
  });

  describe('GET /health assistant key', () => {
    it('omits the assistant key when disabled', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.json()).not.toHaveProperty('assistant');
    });

    it('includes the assistant key when enabled', async () => {
      mocks.assistantEnabled = true;
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.json().assistant).toEqual({ enabled: true, model: 'test-model' });
    });
  });
});

describe('chat audit', () => {
  it('logs the question, tools, outcome and visitor of a chat turn, never the answer', async () => {
    const { auditChat } = await import('../../../src/http/routes/assistant.js');
    const lines = [];
    const log = { info: (fields, msg) => lines.push({ fields, msg }) };
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: '  Is   Base mainnet healthy?\n' }
    ];
    const job = { id: 'j1', status: 'done', error: null, result: { reply: 'Yes, all good.', toolCalls: [{ name: 'get_rpc_monitor_by_id', args: {} }], degraded: false } };
    auditChat({ job, messages, context: { view: 'chain', chainId: 8453 }, visitor: { ip: '203.0.113.7', country: 'CA', kind: 'dashboard' }, startedAt: Date.now() - 1200, log });
    expect(lines).toHaveLength(1);
    expect(lines[0].msg).toBe('chat access');
    expect(lines[0].fields).toMatchObject({
      audit: 'chat', job: 'j1', question: 'Is Base mainnet healthy?', turns: 3, view: 'chain', chainId: 8453,
      outcome: 'ok', tools: ['get_rpc_monitor_by_id'], ip: '203.0.113.7', country: 'CA', kind: 'dashboard'
    });
    expect(lines[0].fields.ms).toBeGreaterThanOrEqual(1200);
    expect(JSON.stringify(lines[0].fields)).not.toContain('all good');
  });

  it('records off-topic, degraded and failed turns, and cuts a long question', async () => {
    const { auditChat } = await import('../../../src/http/routes/assistant.js');
    const lines = [];
    const log = { info: (fields) => lines.push(fields) };
    const long = [{ role: 'user', content: 'x'.repeat(800) }];
    auditChat({ job: { id: 'a', status: 'done', result: { offTopic: true, toolCalls: [] } }, messages: long, startedAt: Date.now(), log });
    auditChat({ job: { id: 'b', status: 'done', result: { degraded: true, toolCalls: [] } }, messages: long, startedAt: Date.now(), log });
    auditChat({ job: { id: 'c', status: 'error', error: 'Assistant LLM unreachable', result: null }, messages: long, startedAt: Date.now(), log });
    expect(lines.map(l => l.outcome)).toEqual(['off_topic', 'degraded', 'error']);
    expect(lines[2].error).toBe('Assistant LLM unreachable');
    expect(lines[0].question).toHaveLength(501);
  });
});
