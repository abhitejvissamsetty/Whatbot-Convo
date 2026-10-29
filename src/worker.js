import { bootstrap } from './bootstrap.js';
const context = await bootstrap();
if (context.config.storeDriver === 'memory') throw new Error('Standalone worker requires MySQL; mock worker runs inside server');
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true; });
while (!stopping) {
  try { await context.worker.maintenance(); await context.worker.tick(); }
  catch (error) { context.log('worker_failed', { code: error.code || 'INTERNAL_ERROR' }); }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
await context.store.close();
