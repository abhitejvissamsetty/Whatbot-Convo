import { randomUUID, createHash } from 'node:crypto';
import { normalizeWa } from '../security/core.js';

export const id = () => randomUUID();
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export async function customerConversation(tx, wa, now = Date.now()) {
  wa = normalizeWa(wa);
  let customer = await tx.get('customers', wa);
  if (!customer) { customer = { id: wa, waId: wa, locale: 'en', createdAt: now }; await tx.set('customers', wa, customer); }
  let conversation = await tx.get('conversations', wa);
  if (!conversation) { conversation = { id: wa, customerId: wa, handoff: false, agentId: null, lastInboundAt: 0, createdAt: now }; await tx.set('conversations', wa, conversation); }
  return { customer, conversation };
}
export async function enqueue(tx, key, type, payload, now = Date.now()) {
  if (await tx.get('jobs', key)) return;
  await tx.set('jobs', key, { type, payload, status: 'pending', attempts: 0, availableAt: now, createdAt: now });
}
export async function outbound(tx, key, conversationId, message, now = Date.now()) {
  if (await tx.get('outbox', key)) return;
  await tx.set('outbox', key, { conversationId, message, status: 'pending', createdAt: now });
  await enqueue(tx, `send:${key}`, 'send', { outboxId: key }, now);
}
export async function handoff(tx, conversationId, reason, now = Date.now()) {
  const conversation = await tx.get('conversations', conversationId);
  if (!conversation.handoff) {
    await tx.set('handoffs', id(), { conversationId, reason: String(reason).slice(0, 500), startedAt: now, closedAt: null, agentId: null });
    await tx.set('conversations', conversationId, { ...conversation, handoff: true, agentId: null });
  }
}
