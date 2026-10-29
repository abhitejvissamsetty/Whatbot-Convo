import { token } from '../security/core.js';
import { digest, enqueue, handoff, outbound } from '../services/data.js';

export class Worker {
  constructor(context) { Object.assign(this, context); this.running = false; this.lastMaintenance = 0; }
  async claim() {
    return this.store.transaction(async tx => {
      const jobs = await tx.list('jobs');
      const ready = jobs.filter(j => (this.config.notificationsEnabled !== false || j.type !== 'send') && ((j.status === 'pending' && j.availableAt <= this.now()) || (j.status === 'running' && j.leaseUntil <= this.now()))).sort((a, b) => a.createdAt - b.createdAt);
      const job = ready.find(j => !jobs.some(other => other.id !== j.id && other.status === 'running' && other.leaseUntil > this.now() && j.payload.customerId && j.payload.customerId === other.payload.customerId));
      if (!job) return null;
      const claimed = { ...job, status: 'running', attempts: job.attempts + 1, lease: token(), leaseUntil: this.now() + 600000 };
      await tx.set('jobs', job.id, claimed); return claimed;
    });
  }
  async send(outboxId) {
    const item = await this.store.transaction(async tx => {
      const item = await tx.get('outbox', outboxId);
      if (!item || ['sent', 'suppressed', 'uncertain', 'resolved'].includes(item.status)) return null;
      if (item.status === 'sending') { await tx.set('outbox', item.id, { ...item, status: 'uncertain' }); return null; }
      const conversation = await tx.get('conversations', item.conversationId);
      if ((item.message.conversational || item.message.handoffAck) && this.config.assistantEnabled === false) { await tx.set('outbox', item.id, { ...item, status: 'suppressed', blockedReason: 'ASSISTANT_PAUSED' }); return null; }
      if (item.message.conversational && conversation.handoff) { await tx.set('outbox', item.id, { ...item, status: 'suppressed' }); return null; }
      if (item.message.type === 'flow') {
        const flow = (await tx.list('flows')).find(f => f.token === item.message.token);
        const cart = await tx.get('carts', item.conversationId);
        if (!flow || flow.expiresAt <= this.now() || flow.state === 'ORDER_PENDING' || flow.cartRevision !== cart?.revision) {
          await tx.set('outbox', item.id, { ...item, status: 'suppressed', blockedReason: 'STALE_FLOW' }); return null;
        }
      }
      let message = item.message;
      if (this.now() - conversation.lastInboundAt >= 24 * 3600000) {
        const template = this.config.templates[message.event];
        if (!template) { await tx.set('outbox', item.id, { ...item, status: 'blocked', blockedReason: 'TEMPLATE_REQUIRED' }); return null; }
        message = { type: 'template', name: template.name, language: template.language, parameters: [String(message.orderId), message.orderStatus] };
      }
      await tx.set('outbox', item.id, { ...item, status: 'sending', attemptedAt: this.now() });
      return { ...item, message };
    });
    if (!item) return;
    let result;
    try { result = await this.meta.send(item.conversationId, item.message); }
    catch (error) {
      await this.store.transaction(async tx => {
        const current = await tx.get('outbox', item.id);
        await tx.set('outbox', item.id, { ...current, status: error.deliveryCertain ? 'pending' : 'uncertain', errorCode: error.code || 'SEND_FAILED' });
      });
      if (error.deliveryCertain) throw error;
      return; // Meta has no application idempotency key; do not blindly duplicate ambiguous sends.
    }
    await this.store.transaction(async tx => {
      const current = await tx.get('outbox', item.id);
      await tx.set('outbox', item.id, { ...current, status: 'sent', providerId: result.id, sentAt: this.now() });
      await tx.set('messages', `out:${item.id}`, { conversationId: item.conversationId, direction: 'out', providerId: result.id, text: item.message.text || (item.message.type === 'flow' ? '[Checkout Flow]' : '[Approved template]'), type: item.message.type, createdAt: this.now(), status: 'accepted' });
    });
  }
  async process(job) {
    const p = job.payload;
    if (job.type === 'inbound') {
      const payment = p.text.match(/^(?:pay|retry payment(?: for)?|payment link(?: for)?)\s+(?:order\s*#?)?(\d+)\s*$/i);
      const conversation = await this.store.transaction(tx => tx.get('conversations', p.customerId));
      if (payment && !conversation.handoff && this.config.assistantEnabled !== false) {
        try { await this.orders.paymentLink(p.customerId, Number(payment[1]), digest(p.messageId)); }
        catch (error) {
          if (!error.status || error.status >= 500) throw error;
          await this.store.transaction(tx => outbound(tx, `reply:${digest(p.messageId)}`, p.customerId, { type: 'text', text: error.message, conversational: true }, this.now()));
        }
      } else await this.agent.run(p.customerId, p.messageId, p.text);
    }
    else if (job.type === 'send') await this.send(p.outboxId);
    else if (job.type === 'reconcile') await this.orders.reconcile(p.orderId);
    else if (job.type === 'flow_completion') {
      await this.store.transaction(async tx => {
        const flow = await this.checkout.session(tx, p.token, p.customerId);
        // Completion messages only acknowledge backend-created orders, never create them.
        if (flow.state !== 'ORDER_PENDING') await handoff(tx, p.customerId, 'Flow completed without confirmed backend order', this.now());
      });
    } else if (job.type === 'unsupported') {
      await this.store.transaction(tx => outbound(tx, `unsupported:${digest(p.messageId)}`, p.customerId, { type: 'text', text: 'Please send a text message, or ask for a human operator.', conversational: true }, this.now()));
    } else throw new Error('Unknown job type');
  }
  async tick(limit = 20) {
    if (this.running) return 0;
    this.running = true;
    let processed = 0;
    try {
      if (this.settings) await this.settings.refresh();
      await this.store.transaction(tx => tx.set('settings', 'worker-health', { lastHeartbeatAt: this.now(), status: 'running' }));
      while (processed < limit) {
        const job = await this.claim(); if (!job) break;
        try {
          await this.process(job);
          await this.finish(job);
        } catch (error) { await this.finish(job, error); }
        processed++;
      }
      return processed;
    } finally { this.running = false; }
  }
  async finish(job, error) {
    await this.store.transaction(async tx => {
      const current = await tx.get('jobs', job.id);
      if (current?.lease !== job.lease) return;
      const status = error ? (job.attempts >= 6 || (error.status >= 400 && error.status < 500 && error.status !== 429) ? 'failed' : 'pending') : 'done';
      await tx.set('jobs', job.id, { ...current, status, availableAt: this.now() + Math.min(300000, 1000 * 2 ** job.attempts), completedAt: status === 'done' ? this.now() : null, errorCode: error?.code || (error ? 'INTERNAL_ERROR' : null), leaseUntil: 0 });
      if (job.payload.eventId) {
        const event = await tx.get('events', job.payload.eventId);
        if (event) await tx.set('events', event.id, { ...event, status: error ? status : 'processed', processedAt: error ? null : this.now() });
      }
      if (error && status === 'failed' && job.payload.customerId) await handoff(tx, job.payload.customerId, 'Background processing needs review', this.now());
    });
    if (error) this.log('job_failed', { jobType: job.type, code: error.code || 'INTERNAL_ERROR', attempts: job.attempts });
  }
  async maintenance() {
    if (this.now() - this.lastMaintenance < this.config.reconcileInterval) return;
    this.lastMaintenance = this.now();
    await this.store.transaction(async tx => {
      const bucket = Math.floor(this.now() / this.config.reconcileInterval);
      for (const order of await tx.list('orders')) {
        if (order.createdAt > this.now() - this.config.retentionDays * 86400000) await enqueue(tx, `periodic:${order.wcOrderId}:${bucket}`, 'reconcile', { orderId: order.wcOrderId }, this.now());
      }
      for (const flow of await tx.list('flows')) if (flow.expiresAt <= this.now() && !['ORDER_PENDING', 'CANCELLED'].includes(flow.state)) await tx.set('flows', flow.id, { ...flow, state: 'EXPIRED' });
      for (const session of await tx.list('sessions')) if (session.expiresAt <= this.now()) await tx.delete('sessions', session.id);
      for (const usage of await tx.list('usage')) if (usage.id.startsWith('rate:') && usage.until <= this.now()) await tx.delete('usage', usage.id);
      const cutoff = this.now() - this.config.retentionDays * 86400000;
      for (const collection of ['messages', 'mock_messages', 'events', 'usage', 'jobs', 'outbox', 'flows']) {
        for (const record of await tx.list(collection)) {
          const timestamp = record.createdAt || record.receivedAt || 0;
          const terminal = collection === 'jobs' ? ['done', 'failed'].includes(record.status) : collection === 'outbox' ? ['sent', 'suppressed', 'resolved'].includes(record.status) : collection === 'flows' ? ['EXPIRED', 'ORDER_PENDING', 'CANCELLED'].includes(record.state) : true;
          if (timestamp && timestamp < cutoff && terminal) await tx.delete(collection, record.id);
        }
      }
    });
  }
}
