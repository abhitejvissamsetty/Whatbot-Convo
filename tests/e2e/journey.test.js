import test from 'node:test';
import assert from 'node:assert/strict';
import { inject, setup, wa, contact, address } from '../helpers.js';
const origin = { origin: 'http://localhost:3000' };

test('complete local HTTP journey: discovery, Flow, pending order, verified payment, operator inbox', async () => {
  const c = await setup();
  await c.operators.create('admin@example.test', 'long-test-password-123', 'admin');
  const login = await inject(c, '/api/operator/login', { method: 'POST', data: { email: 'admin@example.test', password: 'long-test-password-123' }, headers: origin });
  assert.equal(login.status, 200);
  const headers = { ...origin, cookie: login.headers['set-cookie'].split(';')[0], 'x-csrf-token': login.body.csrf };
  assert.equal((await inject(c, '/api/operator/conversations')).status, 401);
  assert.equal((await inject(c, `/api/operator/conversations/${wa}/claim`, { method: 'POST', data: {}, headers: { ...headers, 'x-csrf-token': 'wrong' } })).status, 403);
  assert.equal((await inject(c, '/api/mock/message', { method: 'POST', data: { waId: wa, text: 'Hi' }, headers })).status, 200);
  await inject(c, '/api/mock/message', { method: 'POST', data: { waId: wa, text: 'buy 101 1001 x2' }, headers });
  const flows = await inject(c, '/api/mock/flows', { headers }); const f = flows.body.at(-1);
  let result;
  for (const [screen, data] of [['PRODUCT', {}], ['CUSTOMER', contact], ['DELIVERY', address]]) {
    result = await inject(c, '/api/mock/checkout', { method: 'POST', headers, data: { token: f.token, waId: wa, screen, data } }); assert.equal(result.status, 200);
  }
  const review = result.body;
  result = await inject(c, '/api/mock/checkout', { method: 'POST', headers, data: { token: f.token, waId: wa, screen: 'REVIEW', data: { confirm: true, shipping_method: review.data.shipping_method, quote_fingerprint: review.data.quote_fingerprint } } });
  const orderId = Number(result.body.data.extension_message_response.params.order_id);
  assert.equal((await c.woo.order(orderId)).paid, false);
  assert.equal((await inject(c, '/api/mock/pay', { method: 'POST', data: { orderId }, headers })).status, 200);
  const messages = await inject(c, `/api/operator/conversations/${wa}/messages`, { headers });
  assert(messages.body.some(m => /Payment verified/.test(m.text)));
  const metrics = await inject(c, '/api/operator/metrics', { headers }); assert.equal(metrics.body.orders.PAID_VERIFIED, 1);
  assert.equal((await inject(c, '/api/operator/logout', { method: 'POST', data: {}, headers })).status, 200);
  assert.equal((await inject(c, '/api/operator/me', { headers })).status, 401);
});
test('operator assignment and origin checks reject unauthorized mutations', async () => {
  const c = await setup();
  const first = await c.operators.create('one@example.test', 'operator-password-one');
  const second = await c.operators.create('two@example.test', 'operator-password-two');
  await c.operators.action(wa, 'claim', first);
  await assert.rejects(c.operators.action(wa, 'claim', second), e => e.code === 'ALREADY_ASSIGNED');
  await assert.rejects(c.operators.action(wa, 'reply', second, { text: 'x', requestId: 'a' }), e => e.code === 'ACCESS_DENIED');
  assert.equal((await inject(c, '/api/operator/login', { method: 'POST', data: { email: 'one@example.test', password: 'operator-password-one' }, headers: { origin: 'https://attacker.example' } })).status, 403);
  const html = await inject(c, '/'); assert.equal(html.status, 200); assert.match(html.headers['content-security-policy'], /frame-ancestors 'none'/);
});
