import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, wa, placed, metaMessage } from '../helpers.js';
import { deleteCustomer } from '../../src/services/privacy.js';
test('customer deletion previews, removes only target data, and refuses unpaid orders', async () => {
  const c = await setup(); await c.events.whatsapp(metaMessage(c)); await c.worker.tick(50);
  const preview = await deleteCustomer(c.store, wa);
  assert.equal(preview.applied, false); assert(preview.counts.messages > 0);
  assert(await c.store.transaction(tx => tx.get('customers', wa)));
  await deleteCustomer(c.store, wa, true);
  assert.equal(await c.store.transaction(tx => tx.get('customers', wa)), undefined);
  const c2 = await setup(); await placed(c2);
  await assert.rejects(deleteCustomer(c2.store, wa, true), e => e.code === 'UNRESOLVED_ORDER');
});
