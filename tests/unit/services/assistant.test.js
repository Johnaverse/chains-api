import { describe, it, expect, vi, beforeEach } from 'vitest';

// Guard off here — these tests target the tool loop itself. The guard's own
// behaviour is covered in assistant-guard.test.js.
vi.mock('../../../config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ASSISTANT_TOPIC_GUARD: false
}));

vi.mock('../../../mcp-tools.js', () => ({
  getToolDefinitions: vi.fn(() => [
    {
      name: 'search_chains',
      description: 'Search chains',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
    },
    {
      name: 'get_chain_by_id',
      description: 'Get chain by id',
      inputSchema: { type: 'object', properties: { chainId: { type: 'number' } }, required: ['chainId'] }
    }
  ]),
  handleToolCall: vi.fn(async (name) => ({
    content: [{ type: 'text', text: `{"tool":"${name}","result":"ok"}` }]
  }))
}));

import { handleToolCall } from '../../../mcp-tools.js';
import { runAssistant, buildSystemPrompt, sanitizeReply, looksLikeLeakedToolCall, AssistantUnavailableError } from '../../../src/services/assistant.js';
import { _resetAssistantToolsForTests } from '../../../src/services/assistantTools.js';

const noopLog = { info: () => {}, warn: () => {} };

function llmResponse(message, usage) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message }], usage })
  };
}

function toolCallMessage(name, args, id = 'call_1') {
  return { role: 'assistant', content: null, tool_calls: [{ id, function: { name, arguments: args } }] };
}

function fetchSequence(responses) {
  const calls = [];
  const impl = vi.fn(async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  impl.calls = calls;
  return impl;
}

describe('runAssistant', () => {
  beforeEach(() => {
    _resetAssistantToolsForTests();
    vi.mocked(handleToolCall).mockClear();
  });

  it('runs a tool call turn then returns the final answer', async () => {
    const fetchImpl = fetchSequence([
      llmResponse(toolCallMessage('search_chains', '{"query":"base"}')),
      llmResponse({ role: 'assistant', content: 'Base mainnet is chain `8453`.' }, { prompt_tokens: 100, completion_tokens: 20 })
    ]);
    const steps = [];
    const result = await runAssistant({ messages: [{ role: 'user', content: 'what chain id is base?' }], log: noopLog, fetchImpl, onStep: s => steps.push(s) });

    expect(result.reply).toBe('Base mainnet is chain `8453`.');
    expect(steps).toEqual(['thinking', 'using search_chains', 'thinking about the results']);
    expect(result.degraded).toBe(false);
    expect(result.toolCalls).toEqual([{ name: 'search_chains', args: { query: 'base' } }]);
    expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 20 });
    expect(handleToolCall).toHaveBeenCalledWith('search_chains', { query: 'base' });
    // Second LLM call must carry the tool result back
    const second = fetchImpl.calls[1].body;
    expect(second.messages.some((m) => m.role === 'tool')).toBe(true);
  });

  it('passes a clarifying question straight through without tools', async () => {
    const fetchImpl = fetchSequence([
      llmResponse({ role: 'assistant', content: 'Do you mean Base mainnet (8453) or Base Sepolia (84532)?' })
    ]);
    const result = await runAssistant({ messages: [{ role: 'user', content: 'is base down?' }], log: noopLog, fetchImpl });
    expect(result.reply).toMatch(/8453.*84532/);
    expect(result.toolCalls).toEqual([]);
    expect(result.degraded).toBe(false);
  });

  it('sends the system prompt first and the model name from config', async () => {
    const fetchImpl = fetchSequence([llmResponse({ role: 'assistant', content: 'hi' })]);
    await runAssistant({ messages: [{ role: 'user', content: 'hello' }], context: { view: 'incidents', chainId: 10 }, log: noopLog, fetchImpl });
    const body = fetchImpl.calls[0].body;
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('chain 10');
    expect(body.messages[0].content).toContain('"incidents" tab');
    expect(body.stream).toBe(false);
    expect(body.tools.length).toBe(2);
    expect(body.tools[0]).toMatchObject({ type: 'function', function: { name: 'search_chains' } });
    // No ASSISTANT_LLM_API_KEY configured → no Authorization header sent
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBeUndefined();
  });

  it('treats leaked tool-call text as a failed turn and retries instead of returning garbage', async () => {
    const fetchImpl = fetchSequence([
      // Server leaked the model's tool call into content with no tool_calls.
      llmResponse({ role: 'assistant', content: 'get_chain_by_id to=functions.get_chain_by_id  base' }),
      llmResponse({ role: 'assistant', content: 'Base mainnet is chain `8453`.' })
    ]);
    const result = await runAssistant({ messages: [{ role: 'user', content: 'what chain id is base?' }], log: noopLog, fetchImpl });
    expect(result.reply).toBe('Base mainnet is chain `8453`.');
    expect(result.reply).not.toMatch(/to=|get_chain_by_id/);
  });

  it('sanitizes a repeated/garbled final answer before returning it', async () => {
    const fetchImpl = fetchSequence([
      llmResponse({ role: 'assistant', content: 'Base is healthy.\n\nBase is healthy.\n\nBase is healthy.' })
    ]);
    const result = await runAssistant({ messages: [{ role: 'user', content: 'q' }], log: noopLog, fetchImpl });
    expect(result.reply).toBe('Base is healthy.');
  });

  it('feeds malformed tool args back, then forces an answer after two strikes', async () => {
    const fetchImpl = fetchSequence([
      llmResponse(toolCallMessage('search_chains', 'not-json')),
      llmResponse(toolCallMessage('search_chains', '{"nope":true}')),
      llmResponse({ role: 'assistant', content: 'Best effort answer.' })
    ]);
    const result = await runAssistant({ messages: [{ role: 'user', content: 'q' }], log: noopLog, fetchImpl });
    expect(result.reply).toBe('Best effort answer.');
    expect(result.toolCalls).toEqual([]);
    // Third call must have been forced to answer without tools
    expect(fetchImpl.calls[2].body.tool_choice).toBe('none');
    // Error results were fed back as tool messages
    const toolMsgs = fetchImpl.calls[2].body.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.length).toBe(2);
    expect(toolMsgs[0].content).toMatch(/ERROR/);
  });

  it('ignores tool calls emitted despite tool_choice none', async () => {
    const fetchImpl = fetchSequence([
      llmResponse(toolCallMessage('search_chains', 'bad')),
      llmResponse(toolCallMessage('search_chains', 'bad')),
      llmResponse({ role: 'assistant', content: 'answer anyway', tool_calls: [{ id: 'x', function: { name: 'search_chains', arguments: '{}' } }] })
    ]);
    const result = await runAssistant({ messages: [{ role: 'user', content: 'q' }], log: noopLog, fetchImpl });
    expect(result.reply).toBe('answer anyway');
    expect(handleToolCall).not.toHaveBeenCalled();
  });

  it('forces a final answer when iterations are exhausted', async () => {
    const looping = () => llmResponse(toolCallMessage('get_chain_by_id', '{"chainId":1}'));
    const fetchImpl = fetchSequence([
      looping(), looping(), looping(), looping(), looping(), looping(),
      llmResponse({ role: 'assistant', content: 'Summary from gathered data.' })
    ]);
    const result = await runAssistant({ messages: [{ role: 'user', content: 'q' }], log: noopLog, fetchImpl });
    expect(result.reply).toBe('Summary from gathered data.');
    expect(result.degraded).toBe(false);
    expect(fetchImpl.calls.length).toBe(7);
    expect(fetchImpl.calls[6].body.tool_choice).toBe('none');
  });

  it('throws AssistantUnavailableError when the first LLM call fails (after one retry)', async () => {
    const fetchImpl = fetchSequence([new Error('ECONNREFUSED'), new Error('ECONNREFUSED')]);
    await expect(
      runAssistant({ messages: [{ role: 'user', content: 'q' }], log: noopLog, fetchImpl })
    ).rejects.toThrow(AssistantUnavailableError);
    expect(fetchImpl.calls.length).toBe(2); // transient-blip retry before giving up
  });

  it('throws AssistantUnavailableError on a non-2xx first response', async () => {
    const fetchImpl = fetchSequence([{ ok: false, status: 500 }, { ok: false, status: 500 }]);
    await expect(
      runAssistant({ messages: [{ role: 'user', content: 'q' }], log: noopLog, fetchImpl })
    ).rejects.toThrow(/500/);
  });

  it('recovers from a single transient error without degrading', async () => {
    const fetchImpl = fetchSequence([
      new Error('one-off 502'),
      llmResponse({ role: 'assistant', content: 'answer after retry' })
    ]);
    const result = await runAssistant({ messages: [{ role: 'user', content: 'q' }], log: noopLog, fetchImpl });
    expect(result.reply).toBe('answer after retry');
    expect(result.degraded).toBe(false);
  });

  it('never lets a throwing onStep observer break the run', async () => {
    const fetchImpl = fetchSequence([llmResponse({ role: 'assistant', content: 'hi' })]);
    const result = await runAssistant({
      messages: [{ role: 'user', content: 'hello' }],
      log: noopLog,
      fetchImpl,
      onStep: () => { throw new Error('observer bug'); }
    });
    expect(result.reply).toBe('hi');
  });

  it('degrades gracefully when the LLM dies mid-loop', async () => {
    const fetchImpl = fetchSequence([
      llmResponse(toolCallMessage('search_chains', '{"query":"base"}')),
      new Error('socket hang up'),
      new Error('socket hang up')
    ]);
    const result = await runAssistant({ messages: [{ role: 'user', content: 'q' }], log: noopLog, fetchImpl });
    expect(result.degraded).toBe(true);
    expect(result.reply).toMatch(/wasn't able to finish/);
    expect(result.toolCalls).toEqual([{ name: 'search_chains', args: { query: 'base' } }]);
  });

  it('retries once on an empty final message, then degrades', async () => {
    const fetchImpl = fetchSequence([
      llmResponse({ role: 'assistant', content: '' }),
      llmResponse({ role: 'assistant', content: '  ' }),
      llmResponse({ role: 'assistant', content: '' }),
      llmResponse({ role: 'assistant', content: '' })
    ]);
    const result = await runAssistant({ messages: [{ role: 'user', content: 'q' }], log: noopLog, fetchImpl });
    expect(result.degraded).toBe(true);
    expect(result.reply).toMatch(/wasn't able to finish/);
  });

  it('coerces string-typed numeric args before executing the tool', async () => {
    const fetchImpl = fetchSequence([
      llmResponse(toolCallMessage('get_chain_by_id', '{"chainId":"8453"}')),
      llmResponse({ role: 'assistant', content: 'done' })
    ]);
    const result = await runAssistant({ messages: [{ role: 'user', content: 'q' }], log: noopLog, fetchImpl });
    expect(handleToolCall).toHaveBeenCalledWith('get_chain_by_id', { chainId: 8453 });
    expect(result.toolCalls).toEqual([{ name: 'get_chain_by_id', args: { chainId: 8453 } }]);
  });
});

describe('buildSystemPrompt', () => {
  it('includes the current UTC time and core rules', () => {
    const prompt = buildSystemPrompt(undefined, new Date('2026-07-06T12:00:00Z'));
    expect(prompt).toContain('2026-07-06T12:00:00.000Z');
    expect(prompt).toContain('DISAMBIGUATE NETWORKS');
    expect(prompt).toContain('LIVE vs STATIC');
    expect(prompt).toContain('STAY ON TOPIC');
    expect(prompt).toContain('UNKNOWN is not DOWN');
    expect(prompt).not.toContain('undefined');
  });

  it('tells the model to use get_stats for summary / "how many" questions', () => {
    const prompt = buildSystemPrompt(undefined, new Date('2026-07-06T12:00:00Z'));
    expect(prompt).toContain('get_stats');
    expect(prompt).toMatch(/SUMMARY \/ "HOW MANY"/);
    expect(prompt).toContain('active vs deprecated');
  });

  it('lists every callable tool by name', () => {
    const prompt = buildSystemPrompt(undefined, new Date('2026-07-06T12:00:00Z'));
    // The mocked registry has two tools — both must appear in the manifest
    expect(prompt).toContain('ALL of these tools exist and are callable: search_chains, get_chain_by_id');
  });
});

describe('sanitizeReply', () => {
  it('collapses degenerate repeated paragraphs and lines', () => {
    const junk = 'Base mainnet (8453) is healthy.\n\nBase mainnet (8453) is healthy.\n\nBase mainnet (8453) is healthy.';
    expect(sanitizeReply(junk)).toBe('Base mainnet (8453) is healthy.');
  });

  it('collapses a whole reply repeated twice (the observed clarifying-question dup)', () => {
    const block = 'I need to check which "Base" network you mean.\n- Base mainnet: 8453\n- Base Sepolia: 84532';
    expect(sanitizeReply(`${block}\n${block}`)).toBe(block);
  });

  it('collapses a block repeated with NO separator (concatenated character-exact)', () => {
    const block = 'Which Base network do you mean?\n\n- Base mainnet: 8453\n- Base Sepolia: 84532';
    expect(sanitizeReply(block + block)).toBe(block);           // 2×, no separator
  });

  it('collapses a single sentence repeated 4× with no separator', () => {
    expect(sanitizeReply('Checking RPC health now. '.repeat(4).trim())).toBe('Checking RPC health now.');
  });

  it('collapses an ABAB multi-block repeat but leaves a non-repeating reply intact', () => {
    const ab = 'Base mainnet: 8453\nBase Sepolia: 84532';
    expect(sanitizeReply(`${ab}\n${ab}`)).toBe(ab);
    const clean = 'Base mainnet is chain `8453`.\n- 5/5 RPCs healthy\n- no incidents';
    expect(sanitizeReply(clean)).toBe(clean);
  });

  it('collapses a repeat whose LAST copy is truncated mid-unit (max_tokens cut)', () => {
    const block = 'Base mainnet (8453) looks healthy: no active incidents and all monitored RPCs are up.';
    expect(sanitizeReply(block + block + block + block.slice(0, 37))).toBe(block);
  });

  it('never rewrites short periodic replies (bare chain IDs, tiny lists)', () => {
    expect(sanitizeReply('2222')).toBe('2222');               // Kava chain id, period 1
    expect(sanitizeReply('1111')).toBe('1111');               // WEMIX chain id
    expect(sanitizeReply('Status:\n- up\n- up')).toBe('Status:\n- up\n- up');
    expect(sanitizeReply('Done. Done.')).toBe('Done. Done.'); // unit below minimum length
  });

  it('stays fast and unchanged on long near-periodic (not exactly periodic) input', () => {
    const nearPeriodic = ('The RPC endpoint responded in time. '.repeat(200) + 'All good.').trim();
    const start = Date.now();
    expect(sanitizeReply(nearPeriodic)).toBe(nearPeriodic);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('collapses a run of 3+ identical lines embedded in a larger reply', () => {
    const junk = 'Summary:\nAll RPCs are up.\nAll RPCs are up.\nAll RPCs are up.\nNo incidents today.';
    expect(sanitizeReply(junk)).toBe('Summary:\nAll RPCs are up.\nNo incidents today.');
  });

  it('strips leaked tool-call / channel syntax', () => {
    const leaked = 'get_chain_by_id to=functions.get_chain_by_id <|channel|> Base is 8453.';
    const out = sanitizeReply(leaked);
    expect(out).not.toMatch(/to=/);
    expect(out).not.toMatch(/<\|/);
    expect(out).toContain('Base is 8453.');
  });

  it('leaves a clean reply untouched (aside from trimming)', () => {
    expect(sanitizeReply('  Arbitrum One is chain `42161`.  ')).toBe('Arbitrum One is chain `42161`.');
  });

  it('does not mangle a legitimate to=<value>, and only collapses WHOLE-reply repeats', () => {
    // eth block tag — must NOT be stripped
    expect(sanitizeReply('Query with to=latest for the newest block.')).toBe('Query with to=latest for the newest block.');
    // a repeated line INSIDE a larger reply (not a whole-tile repeat) is kept
    const partial = 'Status:\n- up\n- up';
    expect(sanitizeReply(partial)).toBe(partial);
  });

  it('preserves indented / code-block formatting', () => {
    const md = 'Steps:\n\n- one\n    - nested\n\n```\ntimeout=30\ntimeout=30\n```';
    expect(sanitizeReply(md)).toBe(md);
  });

  it('returns empty string for falsy input', () => {
    expect(sanitizeReply('')).toBe('');
    expect(sanitizeReply(null)).toBe('');
  });
});

describe('looksLikeLeakedToolCall', () => {
  it('detects real tool-call leak syntax', () => {
    expect(looksLikeLeakedToolCall('to=functions.search_chains')).toBe(true);
    expect(looksLikeLeakedToolCall('get_chain_by_id to=0x2105 to=get_chain_by_id')).toBe(true); // to=<toolname>
    expect(looksLikeLeakedToolCall('search_chains({"query":"base"})')).toBe(true);
    expect(looksLikeLeakedToolCall('<|channel|>commentary')).toBe(true);
  });

  it('does not flag ordinary prose, tool mentions, or benign to= values', () => {
    expect(looksLikeLeakedToolCall('Base mainnet is chain 8453 and looks healthy.')).toBe(false);
    expect(looksLikeLeakedToolCall('The get_forum_news tool returns recent posts.')).toBe(false); // mention, no call syntax
    expect(looksLikeLeakedToolCall('Set the to=latest block tag.')).toBe(false); // benign to=value
    expect(looksLikeLeakedToolCall('See https://scan.example/tx?to=abcdef')).toBe(false); // URL param
  });
});
