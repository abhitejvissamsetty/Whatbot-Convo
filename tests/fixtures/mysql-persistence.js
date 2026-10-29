import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { config } from '../../src/config/env.js';
import { setup, placed, reviewed, wa, inject } from '../helpers.js';
import { deleteCustomer } from '../../src/services/privacy.js';

const state = JSON.parse(readFileSync(0, 'utf8'));
const c = await setup({ config: config({ APP_MODE: 'mock', STORE_DRIVER: 'mysql', MYSQL_URL: process.env.MYSQL_TEST_URL, REQUIRE_PERSISTENCE: 'true' }) });
try {
  if (process.argv[2] === 'seed') {
    const user = await c.operators.create(state.email, state.password, 'admin');
    const login = await c.operators.login(state.email, state.password);
    await c.settings.update({ revision: (await c.settings.read()).revision, values: { storeName: 'Persistence verification' } }, user);
    const placedOrder = await placed(c);
    await c.worker.tick(100);
    for (let i = 0; i < 7; i++) assert.equal((await inject(c, '/api/operator/login', { method: 'POST', headers: { origin: 'http://localhost:3000' }, data: { email: state.email, password: 'incorrect' } })).status, 401);
    console.log(JSON.stringify({ ...state, sessionToken: login.sessionToken, orderId: placedOrder.orderId, flowId: placedOrder.f.id, token: placedOrder.f.token, confirmation: placedOrder.confirmation, messages: await c.meta.history(wa) }));
  } else if (process.argv[2] === 'restart') {
    assert.equal((await c.operators.authenticate(state.sessionToken)).user.email, state.email);
    assert.equal((await c.settings.read()).values.storeName, 'Persistence verification');
    assert.deepEqual(await c.meta.history(wa), state.messages);
    assert.equal((await c.woo.order(state.orderId)).paid, false);
    const retry = await c.checkout.transition(state.token, 'REVIEW', state.confirmation, wa);
    assert.equal(Number(retry.data.extension_message_response.params.order_id), state.orderId);
    await c.orders.paymentLink(wa, state.orderId, 'after-restart');
    await c.woo.markPaid(state.orderId); await c.orders.reconcile(state.orderId); await c.worker.tick(100);
    const second = await reviewed(c);
    const confirmations = await Promise.all(Array.from({ length: 8 }, () => c.checkout.transition(second.f.token, 'REVIEW', second.confirmation, wa)));
    const ids = confirmations.map(r => Number(r.data.extension_message_response.params.order_id));
    assert.equal(new Set(ids).size, 1); assert(ids[0] > state.orderId);
    const rollback = await reviewed(c);
    const original = c.woo.createOrder.bind(c.woo);
    c.woo.createOrder = async (...args) => { await original(...args); throw new Error('Injected rollback'); };
    await assert.rejects(c.checkout.transition(rollback.f.token, 'REVIEW', rollback.confirmation, wa), /Injected rollback/);
    assert.equal(await c.woo.findOrder(rollback.f.id), null);
    c.woo.createOrder = original;
    for (let i = 0; i < 3; i++) assert.equal((await inject(c, '/api/operator/login', { method: 'POST', headers: { origin: 'http://localhost:3000' }, data: { email: state.email, password: 'incorrect' } })).status, 401);
    assert.equal((await inject(c, '/api/operator/login', { method: 'POST', headers: { origin: 'http://localhost:3000' }, data: { email: state.email, password: state.password } })).status, 429);
    assert.equal((await c.operators.metrics()).httpErrors.INVALID_LOGIN, 10);
    const history = await c.meta.history(wa);
    assert.equal(new Set(history.map(m => m.id)).size, history.length);
    console.log(JSON.stringify({ ...state, secondId: ids[0], messages: history }));
  } else {
    assert.equal((await c.woo.order(state.orderId)).paid, true);
    assert.equal((await c.store.transaction(tx => tx.get('orders', state.flowId))).paymentState, 'PAID_VERIFIED');
    assert.deepEqual(await c.meta.history(wa), state.messages);
    await c.woo.markPaid(state.secondId); await c.orders.reconcile(state.secondId); await c.worker.tick(100);
    await deleteCustomer(c.store, wa, true);
    assert.deepEqual(await c.meta.history(wa), []);
    assert.equal((await c.store.transaction(tx => tx.list('mock_orders'))).filter(o => o.customerId === wa).length, 0);
    console.log(JSON.stringify({ verified: true }));
  }
} finally { await c.store.close(); }
