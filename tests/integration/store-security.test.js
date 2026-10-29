import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup, inject } from '../helpers.js';

test('administrator can verify configured WooCommerce read access while data remains explicitly simulated', async () => {
  const c = await setup();
  await c.operators.create('owner@example.test', 'integration-check-password', 'admin');
  const login = await c.operators.login('owner@example.test', 'integration-check-password');
  const headers = { origin: c.config.publicUrl, cookie: `wa_session=${login.sessionToken}`, 'x-csrf-token': login.csrf };
  Object.assign(c.config, { wooUrl: 'https://store.example', wooKey: 'read-key', wooSecret: 'read-secret', bridgeSecret: 'bridge-0123456789abcdef0123456789abcdef' });
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options.method });
    return Response.json(String(url).endsWith('catalog-context') ? { currency: 'INR', bridge_version: '0.2.0' } : [{ id: 42, name: 'Store product', status: 'publish', price: '20.00' }]);
  };
  try {
    const denied = await inject(c, '/api/operator/integrations/woocommerce/check', { method: 'POST', data: {}, headers: { ...headers, 'x-csrf-token': 'wrong' } });
    assert.equal(denied.status, 403); assert.equal(calls.length, 0);
    const result = await inject(c, '/api/operator/integrations/woocommerce/check', { method: 'POST', data: {}, headers });
    assert.equal(result.body.status, 'read_access_verified'); assert.match(result.body.message, /still uses demo data/);
    assert.equal(calls.length, 2); assert(calls.every(c => c.method === 'GET'));
    assert.equal(c.config.mode, 'mock');
    assert.equal((await c.woo.search('Canvas'))[0].id, 102);
    globalThis.fetch = async () => { throw new Error('network unavailable'); };
    const failed = await inject(c, '/api/operator/integrations/woocommerce/check', { method: 'POST', data: {}, headers });
    assert.equal(failed.body.status, 'failed');
  } finally { globalThis.fetch = original; }
});

test('changing a store cannot reuse previously saved masked credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'convo-store-security-'));
  const envPath = join(directory, '.env');
  const original = 'WOO_URL=https://original.example\nWOO_KEY=private-read-key\nWOO_SECRET=private-read-secret\nWOO_BRIDGE_SECRET=bridge-0123456789abcdef0123456789abcdef\n';
  await writeFile(envPath, original);
  try {
    const c = await setup({ envPath });
    const state = await c.settings.deployment();
    await assert.rejects(c.settings.saveDeployment({ revision: state.revision, values: { WOO_URL: 'https://different.example' } }, { id: 'admin' }), e => e.code === 'STORE_CREDENTIALS_REQUIRED');
    assert.equal(await readFile(envPath, 'utf8'), original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
