import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createStore, collections } from '../../src/db/store.js';

test('MySQL keeps checkout, payment, messages, settings, sessions and rate limits across three processes', { skip: !process.env.MYSQL_TEST_URL, timeout: 60000 }, async () => {
  const migration = spawnSync(process.execPath, ['scripts/migrate.js'], { env: { ...process.env, APP_MODE: 'mock', STORE_DRIVER: 'mysql', MYSQL_URL: process.env.MYSQL_TEST_URL }, encoding: 'utf8' });
  assert.equal(migration.status, 0, migration.stderr);
  const store = await createStore({ storeDriver: 'mysql', mysqlUrl: process.env.MYSQL_TEST_URL });
  const before = await store.transaction(async tx => Object.fromEntries(await Promise.all(collections.map(async table => [table, await tx.list(table)]))));
  let state = { email: `persistence-${randomUUID()}@example.test`, password: randomUUID() };
  try {
    for (const phase of ['seed', 'restart', 'verify']) {
      const child = spawnSync(process.execPath, ['tests/fixtures/mysql-persistence.js', phase], { input: JSON.stringify(state), encoding: 'utf8', timeout: 20000, env: process.env });
      assert.equal(child.status, 0, `${phase}: ${child.stderr}`);
      state = JSON.parse(child.stdout);
    }
    assert.equal(state.verified, true);
  } finally {
    // Only this dedicated test database is used; restore its original records.
    await store.transaction(async tx => {
      for (const table of collections) {
        for (const row of await tx.list(table)) if (!before[table].some(r => r.id === row.id)) await tx.delete(table, row.id);
        for (const row of before[table]) await tx.set(table, row.id, row);
      }
    });
    await store.close();
  }
});

test('required persistence rejects an in-memory store', async () => {
  await assert.rejects(createStore({ storeDriver: 'memory', requirePersistence: true }), /Persistent storage required/);
});

test('an unavailable MySQL server fails instead of falling back to memory', async () => {
  await assert.rejects(createStore({ storeDriver: 'mysql', mysqlUrl: 'mysql://unused:unused@127.0.0.1:1/unavailable?connectTimeout=1000', requirePersistence: true }));
});
