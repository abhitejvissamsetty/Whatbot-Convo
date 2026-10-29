import { assert } from '../security/core.js';
import { httpsUrl } from '../security/deployment.js';

const businessCollections = ['customers', 'conversations', 'messages', 'carts', 'flows', 'orders', 'events', 'jobs', 'outbox', 'handoffs', 'mock_orders', 'mock_messages'];

export function storeIdentity(config) {
  return {
    version: 1, mode: config.mode,
    store: config.mode === 'live' ? httpsUrl(config.wooUrl, 'WOO_URL') : null,
    phone: config.mode === 'live' ? config.phoneId : null,
    environment: config.mode === 'live' ? config.integrationEnvironment : 'demo',
  };
}

// Application-managed identity: there is no panel endpoint to rewrite this record.
// Database administrators can still change data; this is not protection against DBA compromise.
export async function ensureStoreIdentity(store, config) {
  const expected = storeIdentity(config);
  await store.transaction(async tx => {
    const current = await tx.get('settings', 'database-identity');
    if (current) {
      assert(Object.entries(expected).every(([key, value]) => current[key] === value), 'DATABASE_IDENTITY_MISMATCH', 'This database belongs to a different mode, store, phone, or environment. Use a separate database or a reviewed migration.', 503);
      return;
    }
    // Old demo accounts/sessions are as unsafe to inherit in live mode as queued jobs.
    const tables = config.mode === 'live' ? [...businessCollections, 'operators', 'sessions', 'settings', 'audit', 'usage'] : businessCollections;
    for (const table of tables) {
      assert((await tx.list(table)).length === 0, 'DATABASE_IDENTITY_UNVERIFIED', 'Existing application data has no verified environment identity. Stop and review its provenance before migration.', 503);
    }
    await tx.set('settings', 'database-identity', expected);
  });
}
