import { assert, normalizeWa } from '../security/core.js';
import { customerConversation, digest, enqueue } from './data.js';

export class Events {
  constructor(context) { Object.assign(this, context); }
  async whatsapp(payload) {
    assert(payload.object === 'whatsapp_business_account' && Array.isArray(payload.entry), 'INVALID_EVENT', 'Invalid WhatsApp event');
    return this.store.transaction(async tx => {
      let count = 0;
      for (const entry of payload.entry) for (const change of entry.changes || []) {
        const value = change.value || {};
        if (this.config.mode === 'live' && value.metadata?.phone_number_id !== this.config.phoneId) continue;
        for (const status of value.statuses || []) {
          const key = `meta-status:${digest([status.id, status.status, status.timestamp])}`;
          if (await tx.get('events', key)) continue;
          await tx.set('events', key, { provider: 'meta', externalEventId: key, receivedAt: this.now(), status: 'processed' });
          const rank = { pending: 0, accepted: 1, sent: 2, delivered: 3, read: 4 };
          for (const message of (await tx.list('messages')).filter(m => m.providerId === status.id && m.direction === 'out')) {
            if ((rank[status.status] || 0) > (rank[message.status] || 0) || (status.status === 'failed' && (rank[message.status] || 0) < 3)) await tx.set('messages', message.id, { ...message, status: status.status });
          }
        }
        for (const message of value.messages || []) {
          assert(typeof message.id === 'string' && message.id.length < 250, 'INVALID_EVENT', 'Message ID required');
          const eventId = `meta:${digest(message.id)}`;
          if (await tx.get('events', eventId)) continue;
          const wa = normalizeWa(message.from);
          const { conversation } = await customerConversation(tx, wa, this.now());
          const timestamp = Number(message.timestamp) * 1000;
          assert(Number.isFinite(timestamp) && timestamp > 0 && timestamp <= this.now() + 300000, 'INVALID_EVENT', 'Invalid message timestamp');
          await tx.set('conversations', wa, { ...conversation, lastInboundAt: Math.max(conversation.lastInboundAt, timestamp) });
          const text = message.type === 'text' ? String(message.text?.body || '').slice(0, 4000) : '';
          await tx.set('messages', eventId, { providerId: message.id, conversationId: wa, direction: 'in', text, type: message.type, createdAt: timestamp, status: 'received' });
          await tx.set('events', eventId, { provider: 'meta', externalEventId: message.id, receivedAt: this.now(), status: 'queued' });
          if (message.type === 'text') await enqueue(tx, eventId, 'inbound', { customerId: wa, messageId: message.id, text, eventId }, this.now());
          else if (message.type === 'interactive' && message.interactive?.nfm_reply) {
            let data; try { data = JSON.parse(message.interactive.nfm_reply.response_json); } catch { data = {}; }
            await enqueue(tx, eventId, 'flow_completion', { customerId: wa, token: data.flow_token, eventId }, this.now());
          } else await enqueue(tx, eventId, 'unsupported', { customerId: wa, messageId: message.id, eventId }, this.now());
          count++;
        }
      }
      return { accepted: count };
    });
  }
  async woocommerce(payload, deliveryId, topic) {
    if (payload.webhook_id && !payload.id) return { accepted: true }; // Signed activation ping.
    assert(Number.isSafeInteger(Number(payload.id)) && Number(payload.id) > 0, 'INVALID_EVENT', 'Order ID required');
    const key = `woo:${digest(deliveryId || [topic, payload])}`;
    return this.store.transaction(async tx => {
      if (await tx.get('events', key)) return { accepted: true, duplicate: true };
      await tx.set('events', key, { provider: 'woo', externalEventId: deliveryId || key, receivedAt: this.now(), status: 'queued' });
      await enqueue(tx, key, 'reconcile', { orderId: Number(payload.id), eventId: key }, this.now());
      return { accepted: true };
    });
  }
}
