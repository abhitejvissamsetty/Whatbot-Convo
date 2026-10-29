import { assert, normalizeWa } from '../security/core.js';
import { digest } from './data.js';
export async function deleteCustomer(store, waId, apply = false) {
  waId = normalizeWa(waId);
  return store.transaction(async tx => {
    assert(await tx.get('customers', waId), 'NOT_FOUND', 'Customer not found', 404);
    const orders = (await tx.list('orders')).filter(o => o.customerId === waId);
    assert(!orders.some(o => o.paymentState === 'PAYMENT_PENDING'), 'UNRESOLVED_ORDER', 'Resolve pending payments before deletion', 409);
    const outbox = (await tx.list('outbox')).filter(o => o.conversationId === waId);
    assert(!outbox.some(o => ['pending', 'sending', 'blocked', 'uncertain'].includes(o.status)), 'UNRESOLVED_DELIVERY', 'Resolve message deliveries before deletion', 409);
    const outboxIds = new Set(outbox.map(o => o.id));
    const orderIds = new Set(orders.map(o => Number(o.wcOrderId)));
    const jobs = (await tx.list('jobs')).filter(j => j.payload.customerId === waId || outboxIds.has(j.payload.outboxId) || orderIds.has(Number(j.payload.orderId)));
    assert(!jobs.some(j => ['pending', 'running'].includes(j.status)), 'UNRESOLVED_WORK', 'Resolve queued/running jobs before deletion', 409);
    const messages = (await tx.list('messages')).filter(m => m.conversationId === waId);
    const eventIds = new Set(jobs.map(j => j.payload.eventId).filter(Boolean));
    for (const m of messages) if (m.direction === 'in') eventIds.add(`meta:${digest(m.providerId)}`);
    const selected = { customers: [waId], conversations: [waId], carts: [waId], orders: orders.map(o => o.id), outbox: outbox.map(o => o.id), jobs: jobs.map(j => j.id), messages: messages.map(m => m.id), events: [...eventIds], settings: outbox.map(o => `review:${digest(o.id)}`) };
    for (const table of ['flows', 'handoffs', 'usage']) selected[table] = (await tx.list(table)).filter(r => r.customerId === waId || r.conversationId === waId || (table === 'usage' && r.id.startsWith(`${waId}:`))).map(r => r.id);
    const counts = Object.fromEntries(Object.entries(selected).map(([table, ids]) => [table, ids.length]));
    selected.mock_orders = (await tx.list('mock_orders')).filter(o => o.customerId === waId || orderIds.has(Number(o.id))).map(o => o.id);
    selected.mock_messages = (await tx.list('mock_messages')).filter(m => m.to === waId).map(m => m.id);
    counts.mock_orders = selected.mock_orders.length;
    counts.mock_messages = selected.mock_messages.length;
    if (apply) for (const [table, ids] of Object.entries(selected)) for (const key of ids) await tx.delete(table, key);
    return { applied: apply, counts, providerRecordsDeleted: false };
  });
}
