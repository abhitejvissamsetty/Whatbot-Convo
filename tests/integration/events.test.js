import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, metaMessage, placed, wa, inject } from '../helpers.js';
import { signature } from '../../src/security/core.js';

test('A01 inbound product message is deduplicated and uses fixture catalog', async () => {
  const c = await setup(); const event = metaMessage(c, 'Canvas');
  await Promise.all([c.events.whatsapp(event), c.events.whatsapp(event)]);
  await c.worker.tick(50);
  assert.equal(c.meta.sent.length, 1); assert.match(c.meta.sent[0].message.text, /299.00/);
  assert.equal((await c.store.transaction(tx => tx.list('messages'))).filter(m => m.direction === 'in').length, 1);
});
test('HTTP verifies raw signed webhooks and challenge', async () => {
  const c = await setup(); const raw = Buffer.from(JSON.stringify(metaMessage(c)));
  assert.equal((await inject(c, '/api/webhooks/whatsapp', { method: 'POST', raw })).status, 401);
  assert.equal((await inject(c, '/api/webhooks/whatsapp', { method: 'POST', raw, headers: { 'x-hub-signature-256': `sha256=${signature(raw, c.config.metaSecret)}` } })).status, 200);
  assert.equal((await inject(c, '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=123')).status, 403);
  const challenge = await inject(c, `/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${c.config.verifyToken}&hub.challenge=123`);
  assert.equal(challenge.text, '123');
  const woo = Buffer.from(JSON.stringify({ id: 5001 }));
  assert.equal((await inject(c, '/api/webhooks/woocommerce', { method: 'POST', raw: woo, headers: { 'x-wc-webhook-signature': signature(woo, c.config.wooWebhookSecret, 'base64') } })).status, 200);
});
test('A07 customer claiming payment and failed gateway leave order unpaid', async () => {
  const c = await setup(); const { orderId, f } = await placed(c);
  await c.events.whatsapp(metaMessage(c, 'I paid', 'claimed-paid')); await c.worker.tick(50);
  assert.equal((await c.store.transaction(tx => tx.get('orders', f.id))).paymentState, 'PAYMENT_PENDING');
  c.woo.orders.get(orderId).status = 'failed'; await c.orders.reconcile(orderId);
  assert.equal((await c.store.transaction(tx => tx.get('orders', f.id))).paymentState, 'FAILED');
  assert(!c.meta.sent.some(m => /Payment verified/.test(m.message.text || '')));
});
test('A08 repeated verified payment creates a single confirmation', async () => {
  const c = await setup(); const { orderId, f } = await placed(c);
  await c.woo.markPaid(orderId);
  await Promise.all([c.orders.reconcile(orderId), c.orders.reconcile(orderId)]); await c.worker.tick(50);
  assert.equal((await c.store.transaction(tx => tx.get('orders', f.id))).paymentState, 'PAID_VERIFIED');
  assert.equal(c.meta.sent.filter(m => /Payment verified/.test(m.message.text || '')).length, 1);
});
test('A09 reconciliation catches missed payment and never regresses verified state', async () => {
  const c = await setup(); const { orderId, f } = await placed(c);
  await c.woo.markPaid(orderId); await c.worker.maintenance(); await c.worker.tick(50);
  assert.equal((await c.store.transaction(tx => tx.get('orders', f.id))).paymentState, 'PAID_VERIFIED');
  Object.assign(c.woo.orders.get(orderId), { paid: false, status: 'pending', transaction_id: '' });
  await c.orders.reconcile(orderId);
  assert.equal((await c.store.transaction(tx => tx.get('orders', f.id))).paymentState, 'PAID_VERIFIED');
});
test('A11 mock English and Telugu responses preserve catalog facts', async () => {
  const c = await setup();
  await c.events.whatsapp(metaMessage(c, 'Hi', 'english')); await c.worker.tick(50);
  assert.match(c.meta.sent.at(-1).message.text, /Available products/);
  await c.events.whatsapp(metaMessage(c, 'నమస్తే', 'telugu')); await c.worker.tick(50);
  assert.match(c.meta.sent.at(-1).message.text, /అందుబాటులో/); assert.match(c.meta.sent.at(-1).message.text, /299.00/);
});
test('A12 human handoff pauses bot; operator claims, replies, and resumes', async () => {
  const c = await setup(); const user = await c.operators.create('agent@example.test', 'long-password-for-tests');
  await c.events.whatsapp(metaMessage(c, 'human', 'human')); await c.worker.tick(50);
  const before = c.meta.sent.length;
  await c.events.whatsapp(metaMessage(c, 'Hi', 'after-human')); await c.worker.tick(50); assert.equal(c.meta.sent.length, before);
  await c.operators.action(wa, 'claim', user);
  await c.operators.action(wa, 'reply', user, { text: 'I can help.', requestId: 'reply-1' });
  await c.operators.action(wa, 'reply', user, { text: 'I can help.', requestId: 'reply-1' });
  await c.worker.tick(50); assert.equal(c.meta.sent.filter(m => m.message.text === 'I can help.').length, 1);
  await c.operators.action(wa, 'resume', user);
  await c.events.whatsapp(metaMessage(c, 'Hi', 'after-resume')); await c.worker.tick(50);
  assert.match(c.meta.sent.at(-1).message.text, /Available/);
});
test('out-of-window messages block without templates and use configured templates', async () => {
  const c = await setup(); const { orderId } = await placed(c); await c.worker.tick(50);
  c.advance(25 * 3600000); await c.woo.markPaid(orderId); await c.orders.reconcile(orderId); await c.worker.tick(50);
  assert.equal((await c.store.transaction(tx => tx.list('outbox'))).filter(o => o.status === 'blocked').length, 1);
  const c2 = await setup(); c2.config.templates.payment_verified = { name: 'payment_confirmed', language: 'en' };
  const p = await placed(c2); await c2.worker.tick(50); c2.advance(25 * 3600000); await c2.woo.markPaid(p.orderId); await c2.orders.reconcile(p.orderId); await c2.worker.tick(50);
  assert.equal(c2.meta.sent.at(-1).message.type, 'template');
});
test('ambiguous send is recorded as uncertain and never blindly resent', async () => {
  const c = await setup(); let calls = 0;
  c.meta.send = async () => { calls++; throw new Error('Connection lost after acceptance'); };
  await c.events.whatsapp(metaMessage(c)); await c.worker.tick(50); await c.worker.tick(50);
  assert.equal(calls, 1); assert.equal((await c.store.transaction(tx => tx.list('outbox')))[0].status, 'uncertain');
});
test('known provider rejection retries with backoff', async () => {
  const c = await setup(); let calls = 0; const send = c.meta.send.bind(c.meta);
  c.meta.send = async (...args) => { if (++calls === 1) { const e = new Error('Rejected'); e.deliveryCertain = true; throw e; } return send(...args); };
  await c.events.whatsapp(metaMessage(c)); await c.worker.tick(50); assert.equal(calls, 1);
  c.advance(5000); await c.worker.tick(50); assert.equal(calls, 2); assert.equal(c.meta.sent.length, 1);
});
test('message statuses cannot regress from read to sent', async () => {
  const c = await setup(); await c.events.whatsapp(metaMessage(c)); await c.worker.tick(50);
  const providerId = c.meta.sent[0].id;
  for (const status of ['read', 'sent']) await c.events.whatsapp({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: [{ id: providerId, status, timestamp: String(c.now() / 1000) }] } }] }] });
  const m = (await c.store.transaction(tx => tx.list('messages'))).find(m => m.direction === 'out'); assert.equal(m.status, 'read');
});
test('payment retry reuses existing order and denies other customers and paid orders', async () => {
  const c = await setup(); const { orderId } = await placed(c); await c.worker.tick(50);
  await c.events.whatsapp(metaMessage(c, `pay ${orderId}`, 'retry-payment')); await c.worker.tick(50);
  assert.match(c.meta.sent.at(-1).message.text, new RegExp(`Pay order #${orderId}`));
  assert.equal(c.woo.orders.size, 1);
  await assert.rejects(c.orders.paymentLink('919999999999', orderId, 'foreign'), e => e.code === 'ACCESS_DENIED');
  await c.woo.markPaid(orderId);
  await assert.rejects(c.orders.paymentLink(wa, orderId, 'paid'), e => e.code === 'NOT_PAYABLE');
});
