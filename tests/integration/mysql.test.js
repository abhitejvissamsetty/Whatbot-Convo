import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { config } from '../../src/config/env.js';
import { createStore } from '../../src/db/store.js';

test('real MySQL: migrations, rollback, cross-connection locking, unique order IDs', { skip: !process.env.MYSQL_TEST_URL }, async () => {
  const env = { ...process.env, APP_MODE: 'mock', STORE_DRIVER: 'mysql', MYSQL_URL: process.env.MYSQL_TEST_URL };
  const migration = spawnSync(process.execPath, ['scripts/migrate.js'], { env, encoding: 'utf8' });
  assert.equal(migration.status, 0, migration.stderr);
  const store = await createStore(config(env));
  const key = `test-${randomUUID()}`;
  const first = randomUUID(), second = randomUUID();
  try {
    await store.transaction(tx => tx.set('usage', key, { count: 0 }));
    await Promise.all(Array.from({ length: 5 }, () => store.transaction(async tx => { const value = await tx.get('usage', key); await tx.set('usage', key, { count: value.count + 1 }); })));
    assert.equal((await store.transaction(tx => tx.get('usage', key))).count, 5);
    await assert.rejects(store.transaction(async tx => { await tx.set('usage', key, { count: 99 }); throw new Error('rollback'); }));
    assert.equal((await store.transaction(tx => tx.get('usage', key))).count, 5);
    const wcOrderId = Math.floor(Math.random() * 1000000000) + 1000000000;
    await store.transaction(tx => tx.set('orders', first, { checkoutSessionId: first, flowSessionId: first, wcOrderId }));
    await assert.rejects(store.transaction(tx => tx.set('orders', second, { checkoutSessionId: second, flowSessionId: second, wcOrderId })), error => error.code === 'ER_DUP_ENTRY');
    assert.equal((await store.transaction(tx => tx.get('orders', first))).checkoutSessionId, first);
  } finally {
    await store.transaction(async tx => { await tx.delete('usage', key); await tx.delete('orders', first); await tx.delete('orders', second); });
    await store.close();
  }
});
