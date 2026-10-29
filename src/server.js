import { bootstrap } from './bootstrap.js';
import { createHttpServer } from './http/app.js';

const context = await bootstrap();
const server = await createHttpServer(context);
let busy = false;
// In-memory mock data must share one process; live runs a dedicated worker.
const timer = context.config.mode === 'mock' ? setInterval(async () => {
  if (busy) return; busy = true;
  try { await context.worker.maintenance(); await context.worker.tick(); }
  catch (error) { context.log('worker_failed', { code: error.code || 'INTERNAL_ERROR' }); }
  finally { busy = false; }
}, 1000) : null;
server.listen(context.config.port, context.config.host, () => context.log('server_started', { mode: context.config.mode, port: context.config.port }));
server.on('error', async error => {
  if (timer) clearInterval(timer);
  context.log('server_start_failed', { code: error.code || 'LISTEN_FAILED' });
  await context.store.close(); process.exitCode = 1;
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (timer) clearInterval(timer);
  server.close(async () => { while (busy) await new Promise(resolve => setTimeout(resolve, 25)); await context.store.close(); process.exit(0); });
});
