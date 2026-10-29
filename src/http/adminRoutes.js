import { assert, text } from '../security/core.js';
import { audit, integrationRevision } from '../services/settings.js';
import { request } from '../adapters/http.js';
import { digest } from '../services/data.js';
import { listModels, checkAI } from '../ai/models.js';
import { WooRest } from '../adapters/wooRest.js';

export async function adminRoute(context, auth, url, method, body) {
  const { admin, settings, config, store } = context;
  const path = url.pathname.replace('/api/operator/', '');
  const read = () => body();
  const administrator = () => assert(auth.user.role === 'admin', 'ACCESS_DENIED', 'Administrator access required', 403);
  const done = data => ({ handled: true, data });
  if (method === 'GET' && path === 'overview') return done(await admin.overview());
  if (method === 'GET' && path === 'orders') return done(await admin.ordersList());
  if (method === 'GET' && path === 'checkouts') return done(await admin.flowsList());
  if (method === 'GET' && path === 'catalog') return done(await context.woo.search((url.searchParams.get('q') || '').slice(0, 200), null, 10));
  const variants = path.match(/^catalog\/(\d+)\/variations$/);
  if (method === 'GET' && variants) return done(await context.woo.variations(Number(variants[1])));
  if (method === 'POST' && path === 'account/password') { const input = read(); return done(await admin.changePassword(auth.user, input.currentPassword, input.password)); }
  const orderAction = path.match(/^orders\/(all|\d+)\/(reconcile|payment-link)$/);
  if (method === 'POST' && orderAction) {
    const input = read(); const requestId = text(input.requestId, 'Request ID', 100);
    if (orderAction[2] === 'reconcile') return done(await admin.reconcile(orderAction[1], auth.user, requestId));
    const link = (await admin.ordersList()).find(o => Number(o.wcOrderId) === Number(orderAction[1]));
    assert(link, 'NOT_FOUND', 'Order not found', 404);
    const result = await context.orders.paymentLink(link.customerId, link.wcOrderId, digest(requestId));
    await store.transaction(tx => audit(tx, auth.user, 'order.payment_link_queued', link.wcOrderId, context.now()));
    return done(result);
  }
  // Everything below changes store-wide configuration or exposes administrative records.
  const adminPaths = /^(settings|deployment|system|team|queue|audit|retry|maintenance|integrations|ai\/|checkouts\/|deliveries\/)/;
  if (!adminPaths.test(path)) return { handled: false };
  administrator();
  if (method === 'POST' && path === 'ai/models') {
    // Explicit discovery can read a provider catalog even in demo mode; no generation occurs.
    const { config: draft } = await settings.aiDraft(read());
    const result = await listModels(draft);
    await store.transaction(tx => audit(tx, auth.user, 'ai.models_loaded', result.provider, context.now()));
    return done(result);
  }
  if (path === 'settings') {
    if (method === 'GET') return done(await settings.read());
    if (method === 'POST') return done(await settings.update(read(), auth.user));
  }
  if (path === 'deployment') {
    if (method === 'GET') return done(await settings.deployment());
    if (method === 'POST') return done(await settings.saveDeployment(read(), auth.user));
  }
  if (method === 'GET' && path === 'system') return done(await admin.system());
  if (method === 'GET' && path === 'queue') return done(await admin.queue());
  if (method === 'GET' && path === 'audit') return done(await admin.auditList());
  if (path === 'team') {
    if (method === 'GET') return done(await admin.team());
    if (method === 'POST') {
      const input = read();
      const user = await context.operators.create(input.email, input.password, input.role || 'operator');
      await store.transaction(tx => audit(tx, auth.user, 'team.created', user.email, context.now()));
      return done(user);
    }
  }
  const member = path.match(/^team\/([a-f0-9-]{36})$/);
  if (method === 'POST' && member) return done(await admin.updateMember(member[1], read(), auth.user));
  const checkout = path.match(/^checkouts\/([a-f0-9-]{36})\/cancel$/);
  if (method === 'POST' && checkout) return done(await admin.cancelFlow(checkout[1], auth.user));
  if (method === 'POST' && path === 'retry') {
    const input = read();
    assert(['job', 'outbox'].includes(input.kind) && typeof input.id === 'string', 'INVALID_INPUT', 'Select a valid retry target');
    await store.transaction(async tx => {
      if (input.kind === 'job') {
        const job = await tx.get('jobs', input.id);
        assert(job?.status === 'failed', 'INVALID_JOB', 'Only failed jobs can be retried', 409);
        await tx.set('jobs', job.id, { ...job, status: 'pending', attempts: 0, availableAt: context.now() });
      } else {
        const item = await tx.get('outbox', input.id), job = await tx.get('jobs', `send:${input.id}`);
        assert(item?.status === 'blocked' && job, 'INVALID_OUTBOX', 'Only template-blocked messages can be retried automatically', 409);
        await tx.set('outbox', item.id, { ...item, status: 'pending' });
        await tx.set('jobs', job.id, { ...job, status: 'pending', attempts: 0, availableAt: context.now() });
      }
      await audit(tx, auth.user, 'operations.retry', input.id, context.now(), [input.kind]);
    });
    return done({ ok: true });
  }
  if (method === 'POST' && path === 'deliveries/review') {
    const input = read(); return done(await admin.resolveDelivery(input.id, input, auth.user));
  }
  if (method === 'POST' && path === 'maintenance') {
    context.worker.lastMaintenance = 0;
    await context.worker.maintenance();
    await store.transaction(tx => audit(tx, auth.user, 'maintenance.completed', 'retention_and_reconciliation', context.now()));
    return done({ ok: true });
  }
  const integration = path.match(/^integrations\/(woocommerce|whatsapp|ai|openai)\/check$/);
  if (method === 'POST' && integration) {
    const name = integration[1] === 'openai' ? 'ai' : integration[1];
    let result;
    const realWooCheck = name === 'woocommerce' && [config.wooUrl, config.wooKey, config.wooSecret, config.bridgeSecret].every(Boolean);
    if (config.mode === 'mock' && !realWooCheck) {
      if (name === 'woocommerce') await context.woo.search('', null, 1);
      result = { status: 'simulated', message: 'Mock adapter is available. No external connection was tested.' };
    } else {
      try {
        if (name === 'woocommerce') await (config.mode === 'mock' ? new WooRest(config) : context.woo).search('', null, 1);
        if (name === 'whatsapp') { const phone = await request(`https://graph.facebook.com/${config.graphVersion}/${config.phoneId}?fields=id,display_phone_number,verified_name`, { headers: { Authorization: `Bearer ${config.metaToken}` } }); assert(String(phone.id) === String(config.phoneId), 'PROVIDER_RESPONSE', 'Phone identity did not match', 502); }
        if (name === 'ai') await checkAI(config);
        result = { status: 'read_access_verified', message: config.mode === 'mock' ? 'WooCommerce read access verified. The workspace still uses demo data; live activation and checkout testing are separate steps.' : 'Read access verified using active credentials. Sending, checkout, and payment acceptance remain separate checks.' };
      } catch { result = { status: 'failed', message: 'Read check failed. Verify active credentials, permissions, and network access. Saved credential changes require a restart.' }; }
    }
    result.checkedAt = context.now();
    await store.transaction(async tx => { await tx.set('settings', `integration:${name}`, { ...result, credentialRevision: integrationRevision(config, name) }); await audit(tx, auth.user, 'integration.checked', name, context.now(), [result.status]); });
    return done(result);
  }
  return { handled: false };
}
