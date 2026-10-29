import { config } from '../src/config/env.js';
import { createStore } from '../src/db/store.js';
import { ensureStoreIdentity } from '../src/db/identity.js';
import { deleteCustomer } from '../src/services/privacy.js';
const [waId, option] = process.argv.slice(2);
if (!waId || (option && option !== '--apply')) throw new Error('Usage: npm run customer:delete -- WA_ID [--apply]');
const c = config();
if (c.storeDriver !== 'mysql') throw new Error('Deletion CLI requires MySQL');
const store = await createStore(c);
try { await ensureStoreIdentity(store, c); process.stdout.write(`${JSON.stringify(await deleteCustomer(store, waId, option === '--apply'), null, 2)}\n`); }
finally { await store.close(); }
