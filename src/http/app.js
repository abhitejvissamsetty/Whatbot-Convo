import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AppError, assert, equal, verifyMeta, verifyWoo } from '../security/core.js';
import { decryptFlow, encryptFlow } from '../security/flowCrypto.js';
import { digest } from '../services/data.js';
import { adminRoute } from './adminRoutes.js';
import { allowedOrigin } from '../security/origin.js';
import { staticResponse } from './static.js';

const cookieToken = request => (request.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith('wa_session='))?.slice(11);
const json = (status, data, headers = {}) => ({ status, body: JSON.stringify(data), headers: { 'Content-Type': 'application/json', ...headers } });
export function createHandler(context) {
  const { config, store, operators, events, checkout } = context;
  async function rate(key, limit) {
    const now = context.now();
    await store.transaction(async tx => {
      const id = `rate:${digest(key)}`;
      const b = await tx.get('usage', id);
      const next = !b || b.until <= now ? { count: 1, until: now + 60000, createdAt: now } : { ...b, count: b.count + 1 };
      assert(next.count <= limit, 'RATE_LIMIT', 'Too many requests', 429);
      await tx.set('usage', id, next);
    });
  }
  async function route(req, raw) {
    const url = new URL(req.url, config.publicUrl);
    const path = url.pathname;
    const method = req.method;
    const asset = await staticResponse(path, method);
    if (asset) return asset;
    const ip = req.socket?.remoteAddress || 'unknown';
    if (method === 'GET' && path === '/api/health') {
      try { await store.transaction(tx => tx.get('usage', 'health')); return json(200, { status: 'ok', mode: config.mode, persistence: config.storeDriver }); }
      catch { return json(503, { status: 'unavailable' }); }
    }
    await rate(`all:${ip}`, 600);
    if (method === 'GET' && path === '/api/webhooks/whatsapp') {
      assert(url.searchParams.get('hub.mode') === 'subscribe' && equal(url.searchParams.get('hub.verify_token'), config.verifyToken), 'INVALID_TOKEN', 'Verification failed', 403);
      return { status: 200, body: url.searchParams.get('hub.challenge') || '', headers: { 'Content-Type': 'text/plain' } };
    }
    const body = () => {
      assert(String(req.headers['content-type'] || '').split(';')[0] === 'application/json', 'CONTENT_TYPE', 'JSON content type required', 415);
      try { const value = JSON.parse(raw.toString('utf8')); assert(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_JSON', 'Expected JSON object'); return value; }
      catch (error) { if (error instanceof AppError) throw error; throw new AppError('INVALID_JSON', 'Invalid JSON'); }
    };
    if (method === 'POST' && path === '/api/webhooks/whatsapp') {
      assert(verifyMeta(raw, req.headers['x-hub-signature-256'], config.metaSecret), 'INVALID_SIGNATURE', 'Invalid signature', 401);
      return json(200, await events.whatsapp(body()));
    }
    if (method === 'POST' && path === '/api/webhooks/woocommerce') {
      assert(verifyWoo(raw, req.headers['x-wc-webhook-signature'], config.wooWebhookSecret), 'INVALID_SIGNATURE', 'Invalid signature', 401);
      return json(200, await events.woocommerce(body(), req.headers['x-wc-webhook-delivery-id'], req.headers['x-wc-webhook-topic']));
    }
    if (method === 'POST' && path === '/api/flows/data') {
      assert(config.privateKey, 'FLOW_UNCONFIGURED', 'Flow encryption key is not configured', 503);
      assert(verifyMeta(raw, req.headers['x-hub-signature-256'], config.metaSecret), 'INVALID_SIGNATURE', 'Invalid signature', 401);
      const { data, key, iv } = decryptFlow(body(), config.privateKey, config.keyPassphrase);
      try { return { status: 200, body: encryptFlow(await checkout.exchange(data), key, iv), headers: { 'Content-Type': 'text/plain' } }; }
      catch (error) {
        if (!error.status || error.status >= 500) throw error;
        return { status: 200, body: encryptFlow({ screen: data.screen || 'PRODUCT', data: { error: error.message } }, key, iv), headers: { 'Content-Type': 'text/plain' } };
      }
    }
    if (path.startsWith('/api/operator/')) {
      if (method !== 'GET') {
        assert(allowedOrigin(req.headers.origin, config), 'INVALID_ORIGIN', 'Open the panel at the configured application address and try again.', 403);
      }
      if (method === 'POST' && path === '/api/operator/login') {
        await rate(`login:${ip}`, 10);
        const input = body();
        const result = await operators.login(input.email, input.password);
        return json(200, { csrf: result.csrf, user: result.user }, { 'Set-Cookie': `wa_session=${result.sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${config.publicUrl.startsWith('https:') ? '; Secure' : ''}` });
      }
      const sessionToken = cookieToken(req);
      const auth = await operators.authenticate(sessionToken);
      await context.settings.refresh();
      if (method !== 'GET') assert(equal(req.headers['x-csrf-token'], auth.session.csrf), 'INVALID_CSRF', 'CSRF check failed', 403);
      const result = await adminRoute(context, auth, url, method, body);
      if (result.handled) return json(200, result.data);
      if (method === 'GET' && path === '/api/operator/me') return json(200, { user: auth.user, csrf: auth.session.csrf, mode: config.mode });
      if (method === 'POST' && path === '/api/operator/logout') {
        await store.transaction(tx => tx.delete('sessions', digest(sessionToken)));
        return json(200, { ok: true }, { 'Set-Cookie': 'wa_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      }
      if (method === 'GET' && path === '/api/operator/conversations') return json(200, await operators.list());
      if (method === 'GET' && path === '/api/operator/metrics') return json(200, await operators.metrics());
      if (method === 'GET' && path === '/api/operator/operations') {
        assert(auth.user.role === 'admin', 'ACCESS_DENIED', 'Administrator access required', 403);
        return json(200, await store.transaction(async tx => ({ jobs: (await tx.list('jobs')).filter(j => j.status === 'failed').map(j => ({ id: j.id, type: j.type, errorCode: j.errorCode, attempts: j.attempts })), outbox: (await tx.list('outbox')).filter(o => ['blocked', 'uncertain'].includes(o.status)).map(o => ({ id: o.id, status: o.status, blockedReason: o.blockedReason, createdAt: o.createdAt })) })));
      }
      const match = path.match(/^\/api\/operator\/conversations\/(\d{8,15})(?:\/(messages|claim|release|resume|reply))?$/);
      if (match && method === 'GET' && match[2] === 'messages') return json(200, await operators.history(match[1]));
      if (match && method === 'POST' && ['claim', 'release', 'resume', 'reply'].includes(match[2])) return json(200, await operators.action(match[1], match[2], auth.user, body()));
    }
    if (config.mode === 'mock' && path.startsWith('/api/mock/')) {
      // Loopback binding alone is insufficient: prevent browser cross-origin requests.
      if (method !== 'GET') assert(allowedOrigin(req.headers.origin, config), 'INVALID_ORIGIN', 'Open the panel at the configured application address and try again.', 403);
      const auth = await operators.authenticate(cookieToken(req));
      assert(auth.user.role === 'admin', 'ACCESS_DENIED', 'Administrator access required for the test lab', 403);
      if (method !== 'GET') assert(equal(req.headers['x-csrf-token'], auth.session.csrf), 'INVALID_CSRF', 'CSRF check failed', 403);
      if (method === 'GET' && path === '/api/mock/catalog') return json(200, await context.woo.search(''));
      if (method === 'POST' && path === '/api/mock/message') {
        const input = body();
        const payload = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ from: input.waId, id: input.messageId || `demo-${randomUUID()}`, timestamp: String(Math.floor(context.now() / 1000)), type: 'text', text: { body: input.text } }] } }] }] };
        await events.whatsapp(payload); await context.worker.tick(50);
        return json(200, { sent: await context.meta.history(input.waId) });
      }
      if (method === 'POST' && path === '/api/mock/checkout') {
        const input = body();
        await store.transaction(tx => checkout.session(tx, input.token, input.waId));
        const result = input.action === 'BACK' ? await checkout.exchange({ action: 'BACK', flow_token: input.token, screen: input.screen }) : await checkout.transition(input.token, input.screen, input.data, input.waId);
        await context.worker.tick(50); return json(200, result);
      }
      if (method === 'GET' && path === '/api/mock/flows') return json(200, await store.transaction(tx => tx.list('flows')));
      if (method === 'POST' && path === '/api/mock/pay') {
        await context.woo.markPaid(body().orderId); await context.orders.reconcile(body().orderId); await context.worker.tick(50); return json(200, { ok: true });
      }
    }
    throw new AppError('NOT_FOUND', 'Route not found', 404);
  }
  return async function handler(req, res) {
    const correlationId = randomUUID();
    res.setHeader('X-Correlation-ID', correlationId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 262144) throw new AppError('BODY_TOO_LARGE', 'Request too large', 413); chunks.push(chunk); }
      const result = await route(req, Buffer.concat(chunks));
      res.writeHead(result.status, result.headers); res.end(result.body);
    } catch (error) {
      const status = error.status || 500;
      const code = error.code || 'INTERNAL_ERROR';
      try {
        await store.transaction(async tx => {
          const id = `http-error:${code}`;
          const previous = await tx.get('usage', id);
          await tx.set('usage', id, { code, count: (previous?.count || 0) + 1, createdAt: context.now() });
        });
      } catch { /* Database failures still produce an error response and a log. */ }
      context.log(status >= 500 ? 'request_failed' : 'request_rejected', { correlationId, code });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.code || 'INTERNAL_ERROR', message: status < 500 ? error.message : 'Service temporarily unavailable', correlationId }));
    }
  };
}
export async function createHttpServer(context) {
  const handler = createHandler(context);
  let listener = handler;
  try {
    const { default: express } = await import('express');
    const app = express();
    app.disable('x-powered-by');
    // Keep the request stream untouched so signatures cover the exact received bytes.
    app.use(handler); listener = app;
  } catch (error) {
    if (context.config.mode !== 'mock' || error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
  const server = createServer(listener);
  server.requestTimeout = 40000; server.headersTimeout = 10000;
  return server;
}
