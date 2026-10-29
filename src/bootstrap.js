import { config as loadConfig } from './config/env.js';
import { createStore } from './db/store.js';
import { ensureStoreIdentity } from './db/identity.js';
import { MockWoo, MockMeta } from './adapters/mock.js';
import { PersistentMockWoo, PersistentMockMeta } from './adapters/persistentMock.js';
import { WooRest } from './adapters/wooRest.js';
import { MetaCloud } from './adapters/metaCloud.js';
import { AIClient } from './ai/adapters.js';
import { Checkout } from './services/checkout.js';
import { Agent } from './services/agent.js';
import { Events } from './services/events.js';
import { Orders } from './services/orders.js';
import { Operators } from './services/operators.js';
import { Worker } from './jobs/worker.js';
import { Settings } from './services/settings.js';
import { Admin } from './services/admin.js';

export async function bootstrap(overrides = {}) {
  const config = overrides.config || loadConfig();
  const context = { config, now: Date.now, log: (event, fields = {}) => process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`), ...overrides };
  context.store ||= await createStore(config);
  try { await ensureStoreIdentity(context.store, config); }
  catch (error) { if (!overrides.store) await context.store.close(); throw error; }
  context.woo ||= config.mode === 'mock' ? (config.storeDriver === 'mysql' ? new PersistentMockWoo(context.store) : new MockWoo()) : new WooRest(config);
  context.meta ||= config.mode === 'mock' ? (config.storeDriver === 'mysql' ? new PersistentMockMeta(context.store) : new MockMeta()) : new MetaCloud(config);
  context.ai ||= config.mode === 'mock' ? null : new AIClient(config);
  context.settings = new Settings(context);
  await context.settings.refresh();
  context.checkout = new Checkout(context);
  context.agent = new Agent(context);
  context.events = new Events(context);
  context.orders = new Orders(context);
  context.operators = new Operators(context);
  context.admin = new Admin(context);
  context.worker = new Worker(context);
  if (config.mode === 'mock' && config.mockEmail && config.mockPassword) {
    const exists = await context.store.transaction(async tx => (await tx.list('operators')).some(u => u.email === config.mockEmail.toLowerCase()));
    if (!exists) await context.operators.create(config.mockEmail, config.mockPassword, 'admin');
  }
  return context;
}
