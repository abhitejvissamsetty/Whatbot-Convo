import { Readable } from 'node:stream';
import { bootstrap } from '../src/bootstrap.js';
import { config } from '../src/config/env.js';
import { createHandler } from '../src/http/app.js';
import { customerConversation } from '../src/services/data.js';
export const wa = '919876543210';
export const address = { address_1: '1 Test Street', address_2: '', city: 'Hyderabad', state: 'TS', country: 'IN', postcode: '500001' };
export const contact = { name: 'Test Customer', phone: wa, email: 'customer@example.test' };
export async function setup(overrides = {}) {
  let time = Date.now();
  const context = await bootstrap({ config: config({ APP_MODE: 'mock' }), now: () => time, log: () => {}, ...overrides });
  context.advance = duration => { time += duration; };
  await context.store.transaction(async tx => {
    const { conversation } = await customerConversation(tx, wa, context.now());
    await tx.set('conversations', wa, { ...conversation, lastInboundAt: context.now() });
  });
  return context;
}
export function metaMessage(context, body = 'Hi', messageId = 'wamid-1', from = wa) {
  return { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ id: messageId, from, timestamp: String(Math.floor(context.now() / 1000)), type: 'text', text: { body } }] } }] }] };
}
export async function reviewed(context, lines = [{ product_id: 102, variation_id: 0, quantity: 1 }], delivery = address) {
  const f = await context.checkout.start(wa, lines);
  await context.checkout.transition(f.token, 'PRODUCT', {}, wa);
  await context.checkout.transition(f.token, 'CUSTOMER', contact, wa);
  const review = await context.checkout.transition(f.token, 'DELIVERY', delivery, wa);
  return { f, review, confirmation: { confirm: true, shipping_method: review.data.shipping_method, quote_fingerprint: review.data.quote_fingerprint } };
}
export async function placed(context, lines) {
  const r = await reviewed(context, lines);
  const result = await context.checkout.transition(r.f.token, 'REVIEW', r.confirmation, wa);
  return { ...r, result, orderId: Number(result.data.extension_message_response.params.order_id) };
}
export async function inject(context, path, { method = 'GET', data, raw, headers = {}, handler } = {}) {
  const req = Readable.from([raw || (data === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(data)))]);
  Object.assign(req, { url: path, method, headers: { 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  let status, result, responseHeaders = {};
  const res = { setHeader(k, v) { responseHeaders[k.toLowerCase()] = v; }, writeHead(code, h) { status = code; for (const [k, v] of Object.entries(h)) responseHeaders[k.toLowerCase()] = v; }, end(body) { result = Buffer.isBuffer(body) ? body.toString() : body; } };
  await (handler || createHandler(context))(req, res);
  return { status, headers: responseHeaders, text: result, body: responseHeaders['content-type']?.includes('json') ? JSON.parse(result) : result };
}
