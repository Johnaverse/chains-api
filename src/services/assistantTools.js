import Ajv from 'ajv';
import { getToolDefinitions, handleToolCall } from '../../mcp-tools.js';
import { ASSISTANT_TOOL_RESULT_MAX_CHARS } from '../../config.js';

/**
 * Adapter between the MCP tool registry (mcp-tools.js) and the OpenAI
 * chat-completions tool format used by the assistant's LLM. Also validates
 * tool arguments before execution — local models routinely emit wrong types
 * ("1" for 1) or invent fields, so args are coerced and checked against each
 * tool's JSON Schema instead of being trusted.
 */

// coerceTypes fixes the classic local-model mistake of quoting numbers;
// removeAdditional 'all' drops invented fields (the tool schemas don't declare
// additionalProperties:false, so plain `true` would strip nothing).
const ajv = new Ajv({ coerceTypes: true, removeAdditional: 'all', useDefaults: true });

let openAiTools = null;
const validators = new Map();

// The assistant gets only tools DECLARED read-only (`annotations.readOnlyHint`). The registry is
// shared with the MCP servers, so without this a tool added there later — one that writes,
// reloads or sends — would become callable by the model without anyone deciding it should be
// (OWASP LLM06, excessive agency). Undeclared means excluded.
const assistantToolDefinitions = () => getToolDefinitions().filter((t) => t.annotations?.readOnlyHint === true);

export function getOpenAiTools() {
  if (!openAiTools) {
    openAiTools = assistantToolDefinitions().map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema }
    }));
  }
  return openAiTools;
}

function getValidator(name) {
  if (!validators.has(name)) {
    const def = assistantToolDefinitions().find((t) => t.name === name);
    validators.set(name, def ? ajv.compile(def.inputSchema) : null);
  }
  return validators.get(name);
}

/**
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function validateToolArgs(name, args) {
  const validate = getValidator(name);
  if (!validate) return { ok: false, error: `Unknown tool: ${name}` };
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { ok: false, error: 'Tool arguments must be a JSON object' };
  }
  if (validate(args)) return { ok: true };
  const detail = (validate.errors || [])
    .map((e) => `${e.instancePath || 'args'} ${e.message}`)
    .join('; ');
  return { ok: false, error: `Invalid arguments: ${detail}` };
}

/**
 * Validate and execute a tool, flattening the MCP content response to plain
 * text and truncating oversized results so a single tool can't blow the LLM
 * context.
 *
 * @returns {Promise<{text: string, isError: boolean}>}
 */
export async function executeTool(name, args) {
  const check = validateToolArgs(name, args);
  if (!check.ok) return { text: `ERROR: ${check.error}`, isError: true };
  const result = await handleToolCall(name, args);
  let text = (result.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  if (text.length > ASSISTANT_TOOL_RESULT_MAX_CHARS) {
    text = `${text.slice(0, ASSISTANT_TOOL_RESULT_MAX_CHARS)}\n…[truncated]`;
  }
  return { text, isError: result.isError === true };
}

export function _resetAssistantToolsForTests() {
  openAiTools = null;
  validators.clear();
}
