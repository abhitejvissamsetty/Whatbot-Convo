import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../../src/db/store.js';
import { ensureStoreIdentity } from '../../src/db/identity.js';
import { validateLiveSecurity, httpsUrl } from '../../src/security/deployment.js';
import { WooRest } from '../../src/adapters/wooRest.js';

const live = { mode: 'live', wooUrl: 'https://store.example/shop/', phoneId: '123', integrationEnvironment: 'staging' };
const secrets = { publicUrl: 'https://assistant.example', wooUrl: live.wooUrl, metaSecret: 'meta-0123456789abcdef0123456789abcdef', verifyToken: 'verify-0123456789abcdef0123456789abcdef', wooWebhookSecret: 'webhook-0123456789abcdef0123456789abcdef', bridgeSecret: 'bridge-0123456789abcdef0123456789abcdef' };

test('database identity blocks mode, store, phone and environment changes without deleting records', async () => {
  const store = new MemoryStore();
  await ensureStoreIdentity(store, live);
  await store.transaction(tx => tx.set('jobs', 'existing', { status: 'pending' }));
  await ensureStoreIdentity(store, { ...live, wooUrl: 'https://store.example/shop' });
  for (const change of [{ mode: 'mock' }, { wooUrl: 'https://another.example/shop' }, { wooUrl: 'https://store.example/other' }, { phoneId: '456' }, { integrationEnvironment: 'production' }]) {
    await assert.rejects(ensureStoreIdentity(store, { ...live, ...change }), e => e.code === 'DATABASE_IDENTITY_MISMATCH');
    assert.equal((await store.transaction(tx => tx.get('jobs', 'existing'))).status, 'pending');
  }
});

test('unmarked business data and malformed identities fail closed in both modes', async () => {
  for (const table of ['orders', 'jobs', 'customers', 'mock_orders', 'mock_messages']) {
    for (const mode of ['mock', 'live']) {
      const store = new MemoryStore();
      await store.transaction(tx => tx.set(table, 'existing', { retained: true }));
      await assert.rejects(ensureStoreIdentity(store, { ...live, mode }), e => e.code === 'DATABASE_IDENTITY_UNVERIFIED');
      assert.equal(await store.transaction(tx => tx.get('settings', 'database-identity')), undefined);
    }
  }
  const store = new MemoryStore();
  await store.transaction(tx => tx.set('settings', 'database-identity', { mode: 'live' }));
  await assert.rejects(ensureStoreIdentity(store, live), e => e.code === 'DATABASE_IDENTITY_MISMATCH');
});

test('concurrent startup cannot bind one database to two stores', async () => {
  const store = new MemoryStore();
  const results = await Promise.allSettled([ensureStoreIdentity(store, live), ensureStoreIdentity(store, { ...live, wooUrl: 'https://other.example' })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'DATABASE_IDENTITY_MISMATCH').length, 1);
});

test('first live startup cannot inherit unmarked staff, sessions or configuration', async () => {
  for (const table of ['operators', 'sessions', 'settings', 'audit', 'usage']) {
    const store = new MemoryStore();
    await store.transaction(tx => tx.set(table, 'legacy', { retained: true }));
    await assert.rejects(ensureStoreIdentity(store, live), e => e.code === 'DATABASE_IDENTITY_UNVERIFIED');
    assert.equal((await store.transaction(tx => tx.get(table, 'legacy'))).retained, true);
    assert.equal(await store.transaction(tx => tx.get('settings', 'database-identity')), undefined);
  }
});

test('live settings reject sample secrets and ambiguous credential-bearing URLs', () => {
  validateLiveSecurity(secrets);
  for (const key of ['metaSecret', 'verifyToken', 'wooWebhookSecret', 'bridgeSecret']) {
    for (const value of ['', 'short', 'local-meta-secret-change-me', 'a'.repeat(64)]) assert.throws(() => validateLiveSecurity({ ...secrets, [key]: value }), e => e.code === 'UNSAFE_SECRET');
  }
  for (const url of ['http://store.example', 'https://user:pass@store.example', 'https://store.example?target=elsewhere', 'https://store.example#fragment']) assert.throws(() => httpsUrl(url));
});

test('WooCommerce order results never accept payment URLs at another origin', () => {
  const woo = new WooRest({ wooUrl: 'https://store.example' });
  for (const payment_url of ['http://store.example/pay', 'https://store.example.evil.test/pay', 'https://store.example@evil.test/pay', 'javascript:alert(1)', 'https://user:pass@store.example/pay', 'https://store.example/pay#secret']) {
    assert.throws(() => woo.checkedOrder({ id: 1, payment_url }), e => e.code === 'PROVIDER_RESPONSE');
  }
  assert.equal(woo.checkedOrder({ id: 1, payment_url: 'https://store.example/checkout/order-pay/1?key=private' }).id, 1);
  assert.equal(woo.checkedOrder({ id: 1, payment_url: null }).id, 1);
});
