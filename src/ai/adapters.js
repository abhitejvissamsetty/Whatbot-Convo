import { randomUUID } from 'node:crypto';
import { request } from '../adapters/http.js';
import { OpenAIResponses } from '../adapters/openai.js';
import { assert } from '../security/core.js';
import { aiSelection } from './providers.js';

const textOf = message => typeof message.content === 'string' ? message.content : (message.content || []).filter(c => ['input_text', 'output_text', 'text'].includes(c.type)).map(c => c.text).join('\n');
const messageEnvelope = (provider, message) => ({ type: 'provider_message', provider, message });
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args || {}) });
function appendResult(messages, role, content, key = 'content') {
  const last = messages.at(-1);
  if (last?.role === role && Array.isArray(last[key])) last[key].push(content);
  else messages.push({ role, [key]: [content] });
}
function validCalls(calls) {
  const ids = new Set();
  for (const c of calls) { assert(typeof c.call_id === 'string' && c.call_id.length > 0 && !ids.has(c.call_id) && typeof c.name === 'string', 'PROVIDER_RESPONSE', 'Provider returned invalid or duplicate tool calls', 502); ids.add(c.call_id); }
  return calls;
}
export class AnthropicMessages {
  constructor(selection) { this.selection = selection; }
  async respond(input, tools, instructions) {
    const messages = [];
    for (const item of input) {
      if (item.type === 'provider_message') { assert(item.provider === 'anthropic', 'AI_PROTOCOL_MISMATCH', 'Provider changed within an active turn', 500); messages.push(item.message); }
      else if (item.type === 'function_call_output') appendResult(messages, 'user', { type: 'tool_result', tool_use_id: item.call_id, content: item.output });
      else if (item.role) messages.push({ role: item.role === 'assistant' ? 'assistant' : 'user', content: [{ type: 'text', text: textOf(item) }] });
    }
    const s = this.selection;
    const response = await request(`${s.baseUrl}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${s.key}`, 'anthropic-version': s.version }, body: { model: s.model, max_tokens: s.maxOutput, system: instructions, messages, tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })) }, timeout: 30000 });
    assert(Array.isArray(response.content) && response.content.length, 'PROVIDER_RESPONSE', 'Claude returned no usable content', 502);
    assert(response.stop_reason !== 'max_tokens', 'AI_OUTPUT_LIMIT', 'Claude response exceeded the configured output limit', 502);
    const calls = validCalls(response.content.filter(c => c.type === 'tool_use').map(c => call(c.id, c.name, c.input)));
    return { output: [messageEnvelope('anthropic', { role: 'assistant', content: response.content }), ...calls], text: response.content.filter(c => c.type === 'text').map(c => c.text).join('\n') };
  }
}
export class GeminiContent {
  constructor(selection) { this.selection = selection; }
  async respond(input, tools, instructions) {
    const contents = [], calls = new Map(input.filter(i => i.type === 'function_call').map(i => [i.call_id, i]));
    for (const item of input) {
      if (item.type === 'provider_message') { assert(item.provider === 'gemini', 'AI_PROTOCOL_MISMATCH', 'Provider changed within an active turn', 500); contents.push(item.message); }
      else if (item.type === 'function_call_output') {
        const source = calls.get(item.call_id);
        assert(source, 'AI_PROTOCOL_MISMATCH', 'Tool result has no matching call', 500);
        let result; try { result = JSON.parse(item.output); } catch { result = item.output; }
        appendResult(contents, 'user', { functionResponse: { ...(source.nativeId ? { id: source.nativeId } : {}), name: source.name, response: { result } } }, 'parts');
      } else if (item.role) contents.push({ role: item.role === 'assistant' ? 'model' : 'user', parts: [{ text: textOf(item) }] });
    }
    const s = this.selection;
    const response = await request(`${s.baseUrl}/models/${encodeURIComponent(s.model)}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': s.key }, body: { systemInstruction: { parts: [{ text: instructions }] }, contents, tools: [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } }, generationConfig: { maxOutputTokens: s.maxOutput } }, timeout: 30000 });
    const candidate = response.candidates?.[0];
    assert(candidate?.content?.parts?.length && (!candidate.finishReason || candidate.finishReason === 'STOP'), 'PROVIDER_RESPONSE', 'Gemini returned no complete usable response', 502);
    const normalized = validCalls(candidate.content.parts.filter(p => p.functionCall).map(p => ({ ...call(p.functionCall.id || randomUUID(), p.functionCall.name, p.functionCall.args), nativeId: p.functionCall.id || null })));
    // Preserve the original parts, including thoughtSignature, without reconstructing them.
    return { output: [messageEnvelope('gemini', { ...candidate.content, role: 'model' }), ...normalized], text: candidate.content.parts.filter(p => p.text && !p.thought).map(p => p.text).join('\n') };
  }
}
export class CompatibleChat {
  constructor(selection) { this.selection = selection; }
  async respond(input, tools, instructions) {
    const messages = [{ role: 'system', content: instructions }];
    for (const item of input) {
      if (item.type === 'provider_message') { assert(item.provider === 'chat', 'AI_PROTOCOL_MISMATCH', 'Provider changed within an active turn', 500); messages.push(item.message); }
      else if (item.type === 'function_call_output') messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output });
      else if (item.role) messages.push({ role: item.role === 'assistant' ? 'assistant' : 'user', content: textOf(item) });
    }
    const s = this.selection;
    const response = await request(`${s.baseUrl}/chat/completions`, { method: 'POST', headers: s.key ? { Authorization: `Bearer ${s.key}` } : {}, body: { model: s.model, messages, tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })), tool_choice: 'auto', max_tokens: s.maxOutput, stream: false }, timeout: 30000 });
    const choice = response.choices?.[0], message = choice?.message;
    assert(message && choice.finish_reason !== 'length' && choice.finish_reason !== 'content_filter', 'PROVIDER_RESPONSE', 'Provider returned no complete usable response', 502);
    const normalized = validCalls((message.tool_calls || []).map(c => call(c.id, c.function?.name, c.function?.arguments)));
    assert(normalized.length || typeof message.content === 'string' && message.content.trim(), 'PROVIDER_RESPONSE', 'Provider returned no text or tool calls', 502);
    const preserved = { role: 'assistant', content: message.content ?? null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) };
    for (const key of ['reasoning_content', 'reasoning_details', 'reasoning']) if (message[key] !== undefined) preserved[key] = message[key];
    return { output: [messageEnvelope('chat', preserved), ...normalized], text: typeof message.content === 'string' ? message.content : '' };
  }
}
export function createAIAdapter(config) {
  const s = aiSelection(config);
  if (s.protocol === 'responses') return new OpenAIResponses({ model: s.model, openaiKey: s.key, aiMaxOutput: s.maxOutput });
  if (s.protocol === 'anthropic') return new AnthropicMessages(s);
  if (s.protocol === 'gemini') return new GeminiContent(s);
  return new CompatibleChat(s);
}
export class AIClient {
  constructor(config) { this.config = config; }
  // A complete turn uses one immutable provider/model/credential snapshot.
  session() { return createAIAdapter({ ...this.config }); }
  async respond(...args) { return this.session().respond(...args); }
}
