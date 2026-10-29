import { request } from './http.js';
import { assert } from '../security/core.js';
export class MetaCloud {
  constructor(config) { this.config = config; }
  async send(to, message) {
    let content;
    if (message.type === 'template') {
      content = { type: 'template', template: { name: message.name, language: { code: message.language }, components: [{ type: 'body', parameters: message.parameters.map(text => ({ type: 'text', text: String(text) })) }] } };
    } else if (message.type === 'flow') {
      content = { type: 'interactive', interactive: { type: 'flow', body: { text: 'Complete your checkout details securely.' }, action: { name: 'flow', parameters: { flow_message_version: '3', flow_token: message.token, flow_id: this.config.flowId, flow_cta: 'Checkout', flow_action: 'data_exchange', mode: this.config.integrationEnvironment === 'staging' ? 'draft' : 'published' } } } };
    } else content = { type: 'text', text: { body: message.text.slice(0, 4000), preview_url: false } };
    const data = await request(`https://graph.facebook.com/${this.config.graphVersion}/${this.config.phoneId}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${this.config.metaToken}` }, body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...content } });
    assert(typeof data.messages?.[0]?.id === 'string', 'PROVIDER_RESPONSE', 'Provider did not return a message reference', 502);
    return { id: data.messages[0].id };
  }
}
