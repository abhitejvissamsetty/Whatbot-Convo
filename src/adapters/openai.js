import { request } from './http.js';
import { assert } from '../security/core.js';
export class OpenAIResponses {
  constructor(config) { this.config = config; }
  async respond(input, tools, instructions) {
    const response = await request('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${this.config.openaiKey}` }, body: {
      model: this.config.model, instructions, input, tools, parallel_tool_calls: false,
      max_output_tokens: this.config.aiMaxOutput, store: false,
    }, timeout: 30000 });
    assert(Array.isArray(response.output) && !['failed', 'incomplete'].includes(response.status), 'PROVIDER_RESPONSE', 'OpenAI returned no complete usable response', 502);
    return { output: response.output || [], text: (response.output || []).filter(o => o.type === 'message').flatMap(m => m.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('\n') };
  }
}
