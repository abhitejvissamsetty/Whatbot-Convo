import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, wa } from '../helpers.js';
import { redactForAI } from '../../src/services/agent.js';

test('Responses tool loop supplies authoritative data and removes sensitive context', async () => {
  const c = await setup(); c.config.mode = 'live';
  const requests = [];
  c.agent.ai = { async respond(input) {
    requests.push(structuredClone(input));
    if (requests.length === 1) return { output: [{ type: 'function_call', name: 'search_products', arguments: JSON.stringify({ query: 'Canvas', category: null, limit: 5 }), call_id: 'call-1' }] };
    return { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Canvas Bag: INR 299.00' }] }], text: 'Canvas Bag: INR 299.00' };
  } };
  await c.agent.run(wa, 'tool-msg', 'Canvas, email me at private@example.test or +919876543210');
  assert(!JSON.stringify(requests).includes('private@example.test'));
  assert(!JSON.stringify(requests).includes('919876543210'));
  const result = requests[1].find(item => item.type === 'function_call_output');
  assert.equal(result.call_id, 'call-1'); assert.equal(JSON.parse(result.output)[0].price, '299.00');
  await c.worker.tick(); assert.match(c.meta.sent[0].message.text, /299.00/);
  assert.equal(redactForAI('Pay https://store.test/order-pay/12?key=secret'), 'Pay [secure link]');
});
test('agent cannot exceed per-turn tool budget', async () => {
  const c = await setup(); c.config.mode = 'live'; c.config.aiMaxTools = 2;
  c.agent.ai = { async respond() { return { output: [{ type: 'function_call', name: 'get_product', arguments: '{"product_id":102}', call_id: 'call-loop' }] }; } };
  await assert.rejects(c.agent.run(wa, 'loop', 'Canvas'), e => e.code === 'TOOL_LIMIT');
});
test('daily turn cap routes to a human rather than calling the model', async () => {
  const c = await setup(); c.config.aiDailyLimit = 1;
  await c.agent.run(wa, 'first', 'Hi'); await c.agent.run(wa, 'second', 'Hi');
  assert.equal((await c.store.transaction(tx => tx.get('conversations', wa))).handoff, true);
  await c.worker.tick();
  assert(c.meta.sent.some(m => m.message.text === 'A team member will help you from here.'));
});
