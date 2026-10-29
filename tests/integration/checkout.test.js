import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, reviewed, placed, wa, contact, address } from '../helpers.js';

test('A02 exact variation survives Flow and order', async () => {
  const c = await setup();
  const { orderId } = await placed(c, [{ product_id: 101, variation_id: 1002, quantity: 2 }]);
  const order = await c.woo.order(orderId);
  assert.equal(order.lines[0].variation_id, 1002);
  assert.equal(order.lines[0].quantity, 2);
  assert.equal(order.total, '1148.00');
});
test('A03 stock change blocks order placement', async () => {
  const c = await setup(); const { f, confirmation } = await reviewed(c);
  c.woo.products.find(p => p.id === 102).stock = 0;
  await assert.rejects(c.checkout.transition(f.token, 'REVIEW', confirmation, wa), e => e.code === 'OUT_OF_STOCK');
  assert.equal(c.woo.orders.size, 0);
});
test('A04 invalid PIN and unavailable shipping do not create an order', async () => {
  const c = await setup(); const f = await c.checkout.start(wa, [{ product_id: 102, quantity: 1 }]);
  await c.checkout.transition(f.token, 'PRODUCT', {}, wa);
  await c.checkout.transition(f.token, 'CUSTOMER', contact, wa);
  await assert.rejects(c.checkout.transition(f.token, 'DELIVERY', { ...address, postcode: 'bad' }, wa), e => e.code === 'INVALID_ADDRESS');
  c.woo.quote = async () => { const e = new Error('Delivery unavailable'); e.code = 'SHIPPING_UNAVAILABLE'; e.status = 400; throw e; };
  const response = await c.checkout.exchange({ action: 'data_exchange', flow_token: f.token, screen: 'DELIVERY', data: address });
  assert.equal(response.screen, 'DELIVERY'); assert.match(response.data.error, /unavailable/);
  assert.equal(c.woo.orders.size, 0);
});
test('A05 coupon quote total equals payable order total', async () => {
  const c = await setup(); const { f, review, confirmation } = await reviewed(c, undefined, { ...address, coupon: 'DEMO10' });
  assert.match(review.data.summary, /Discount: 29.90/);
  const result = await c.checkout.transition(f.token, 'REVIEW', confirmation, wa);
  const order = await c.woo.order(Number(result.data.extension_message_response.params.order_id));
  assert.equal(order.total, '319.10');
});
test('A06 concurrent final confirmations create one order and payment reference', async () => {
  const c = await setup(); const { f, confirmation } = await reviewed(c);
  const results = await Promise.all(Array.from({ length: 8 }, () => c.checkout.transition(f.token, 'REVIEW', confirmation, wa)));
  assert.equal(new Set(results.map(r => r.data.extension_message_response.params.order_id)).size, 1);
  assert.equal(c.woo.orders.size, 1);
  const links = await c.store.transaction(tx => tx.list('orders')); assert.equal(links.length, 1);
  const outbox = await c.store.transaction(tx => tx.list('outbox')); assert.equal(outbox.filter(o => o.id.startsWith('payment-link:')).length, 1);
});
test('remote order success followed by timeout recovers without duplication', async () => {
  const c = await setup(); const { f, confirmation } = await reviewed(c);
  const create = c.woo.createOrder.bind(c.woo); let calls = 0;
  c.woo.createOrder = async (...args) => { await create(...args); calls++; throw new Error('Network timeout after remote commit'); };
  await assert.rejects(c.checkout.transition(f.token, 'REVIEW', confirmation, wa), /timeout/);
  assert.equal((await c.store.transaction(tx => tx.list('orders'))).length, 0);
  const result = await c.checkout.transition(f.token, 'REVIEW', confirmation, wa);
  assert.equal(result.screen, 'SUCCESS'); assert.equal(c.woo.orders.size, 1); assert.equal(calls, 1);
});
test('price changes require a new review and explicit confirmation', async () => {
  const c = await setup(); const { f, confirmation } = await reviewed(c);
  c.woo.products.find(p => p.id === 102).price = '399.00';
  const response = await c.checkout.transition(f.token, 'REVIEW', confirmation, wa);
  assert.equal(response.screen, 'REVIEW'); assert.match(response.data.error, /changed/); assert.equal(c.woo.orders.size, 0);
  await assert.rejects(c.checkout.transition(f.token, 'REVIEW', confirmation, wa), e => e.code === 'STALE_QUOTE');
  const result = await c.checkout.transition(f.token, 'REVIEW', { ...confirmation, quote_fingerprint: response.data.quote_fingerprint }, wa);
  assert.equal(result.screen, 'SUCCESS');
});
test('missing confirmation, wrong customer, expired token, and stale cart are rejected', async () => {
  const c = await setup(); const { f, confirmation } = await reviewed(c);
  await assert.rejects(c.checkout.transition(f.token, 'REVIEW', { ...confirmation, confirm: false }, wa), e => e.code === 'CONFIRMATION_REQUIRED');
  await assert.rejects(c.checkout.transition(f.token, 'REVIEW', confirmation, '919999999999'), e => e.code === 'INVALID_SESSION');
  await c.checkout.start(wa, [{ product_id: 102, quantity: 2 }]);
  await assert.rejects(c.checkout.transition(f.token, 'REVIEW', confirmation, wa), e => e.code === 'STALE_CART');
  c.advance(c.config.flowTtl + 1);
  await assert.rejects(c.checkout.transition(f.token, 'REVIEW', confirmation, wa), e => e.code === 'EXPIRED_SESSION');
});
test('duplicate lines and ambiguous variable products are rejected', async () => {
  const c = await setup();
  await assert.rejects(c.checkout.start(wa, [{ product_id: 101, quantity: 1 }]), e => e.code === 'OUT_OF_STOCK');
  await assert.rejects(c.checkout.start(wa, [{ product_id: 102, quantity: 1 }, { product_id: 102, quantity: 1 }]), e => e.code === 'INVALID_CART');
});
test('A10 order tool enforces customer ownership and validates tool inputs', async () => {
  const c = await setup(); const { orderId } = await placed(c);
  await assert.rejects(c.agent.execute('get_order_status', { order_id: orderId }, '919999999999', 'm', 1), e => e.code === 'ACCESS_DENIED');
  assert.equal((await c.agent.execute('get_order_status', { order_id: orderId }, wa, 'm', 1)).paid, false);
  await assert.rejects(c.agent.execute('mark_paid', {}, wa, 'm', 1), e => e.code === 'INVALID_TOOL');
  await assert.rejects(c.agent.execute('get_product', { product_id: -1 }, wa, 'm', 1), e => e.code === 'INVALID_TOOL');
});
test('Flow BACK invalidates quote and allows correcting customer details', async () => {
  const c = await setup(); const { f } = await reviewed(c);
  let result = await c.checkout.exchange({ action: 'BACK', flow_token: f.token, screen: 'REVIEW' });
  assert.equal(result.screen, 'DELIVERY');
  result = await c.checkout.exchange({ action: 'BACK', flow_token: f.token, screen: 'DELIVERY' });
  assert.equal(result.screen, 'CUSTOMER');
  assert.equal((await c.store.transaction(tx => tx.get('flows', f.id))).quote, undefined);
  await c.checkout.transition(f.token, 'CUSTOMER', { ...contact, email: 'updated@example.test' }, wa);
  result = await c.checkout.transition(f.token, 'DELIVERY', address, wa);
  assert.equal(result.screen, 'REVIEW'); assert.equal(c.woo.orders.size, 0);
});
