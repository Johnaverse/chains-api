import { describe, it, expect, vi, beforeEach } from 'vitest';
import Ajv from 'ajv';
import { getToolDefinitions, handleToolCall } from '../../../mcp-tools.js';
import {
  getOpenAiTools,
  validateToolArgs,
  executeTool,
  _resetAssistantToolsForTests
} from '../../../src/services/assistantTools.js';

vi.mock('../../../mcp-tools.js', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, handleToolCall: vi.fn(original.handleToolCall) };
});

describe('getOpenAiTools', () => {
  beforeEach(() => _resetAssistantToolsForTests());

  it('converts every MCP tool to the OpenAI function format', () => {
    const tools = getOpenAiTools();
    // Derived from the registry, not a literal: the point of this assertion is that the
    // adapter converts EVERY tool, and a hardcoded count just rots on each new tool.
    expect(tools.length).toBe(getToolDefinitions().length);
    expect(tools.length).toBeGreaterThan(20);
    for (const tool of tools) {
      expect(tool.type).toBe('function');
      expect(tool.function.name).toBeTruthy();
      expect(tool.function.description).toBeTruthy();
      expect(tool.function.parameters.type).toBe('object');
    }
  });

  it('produces schemas that all compile under AJV', () => {
    const ajv = new Ajv({ coerceTypes: true });
    for (const tool of getOpenAiTools()) {
      expect(() => ajv.compile(tool.function.parameters)).not.toThrow();
    }
  });

  it('memoizes the converted list', () => {
    expect(getOpenAiTools()).toBe(getOpenAiTools());
  });
});

describe('validateToolArgs', () => {
  beforeEach(() => _resetAssistantToolsForTests());

  it('accepts valid args', () => {
    expect(validateToolArgs('search_chains', { query: 'base' })).toEqual({ ok: true });
  });

  it('coerces string numbers in place', () => {
    const args = { chainId: '8453' };
    expect(validateToolArgs('get_chain_by_id', args).ok).toBe(true);
    expect(args.chainId).toBe(8453);
  });

  it('strips invented fields instead of failing', () => {
    const args = { query: 'base', madeUp: true };
    expect(validateToolArgs('search_chains', args).ok).toBe(true);
    expect(args).not.toHaveProperty('madeUp');
  });

  it('rejects missing required fields with a readable error', () => {
    const result = validateToolArgs('get_chain_by_id', {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/chainId/);
  });

  it('rejects unknown tools and non-object args', () => {
    expect(validateToolArgs('not_a_tool', {}).ok).toBe(false);
    expect(validateToolArgs('search_chains', 'nope').ok).toBe(false);
    expect(validateToolArgs('search_chains', null).ok).toBe(false);
    expect(validateToolArgs('search_chains', [1]).ok).toBe(false);
  });
});

describe('executeTool', () => {
  beforeEach(() => {
    _resetAssistantToolsForTests();
    vi.mocked(handleToolCall).mockClear();
  });

  it('returns validation errors without calling the tool', async () => {
    const result = await executeTool('get_chain_by_id', {});
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR/);
    expect(handleToolCall).not.toHaveBeenCalled();
  });

  it('flattens content text and propagates isError from the tool', async () => {
    handleToolCall.mockResolvedValueOnce({ content: [{ type: 'text', text: '{"error":"nope"}' }], isError: true });
    const result = await executeTool('search_chains', { query: 'x' });
    expect(result.isError).toBe(true);
    expect(result.text).toBe('{"error":"nope"}');
  });

  it('truncates oversized tool results', async () => {
    handleToolCall.mockResolvedValueOnce({ content: [{ type: 'text', text: 'x'.repeat(20000) }] });
    const result = await executeTool('search_chains', { query: 'x' });
    expect(result.text.length).toBeLessThan(20000);
    expect(result.text).toMatch(/\[truncated\]$/);
  });
});
