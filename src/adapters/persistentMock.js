import { randomUUID } from 'node:crypto';
import { MockWoo } from './mock.js';
import { assert } from '../security/core.js';

// Catalog/quote fixtures remain code. All mutable provider records live in MySQL.
// Checkout passes its transaction: local demo orders commit/roll back together.
// Independent external-provider commits/timeouts are covered by the memory fixtures.
export class PersistentMockWoo extends MockWoo {
  constructor(store) {
    super(); this.store = store;
    delete this.orders; delete this.sessions; delete this.sequence; delete this.sent;
  }
  async findOrder(sessionId, tx) {
    const read = async tx => (await tx.list('mock_orders')).find(o => o.checkout_session_id === sessionId) || null;
    return tx ? read(tx) : this.store.transaction(read);
  }
  async createOrder(sessionId, input, expected, tx) {
    const create = async tx => {
      const existing = await this.findOrder(sessionId, tx);
      if (existing) return existing;
      const quote = await this.quote(input);
      assert(quote.fingerprint === expected, 'QUOTE_CHANGED', 'Your quote changed. Review and confirm again.', 409);
      const sequence = await tx.get('settings', 'mock-woo-sequence');
      const id = (sequence?.value || 5000) + 1;
      const order = { id: String(id), status: 'pending', paid: false, transaction_id: '', total: quote.total, currency: quote.currency, lines: quote.lines, checkout_session_id: sessionId, customerId: input.customer.phone, payment_url: `https://checkout.example.invalid/order-pay/${id}?key=mock`, created_at: Date.now() };
      await tx.set('settings', 'mock-woo-sequence', { value: id });
      await tx.set('mock_orders', id, order);
      return order;
    };
    return tx ? create(tx) : this.store.transaction(create);
  }
  async order(id) {
    const order = await this.store.transaction(tx => tx.get('mock_orders', id));
    assert(order, 'NOT_FOUND', 'Order not found', 404);
    return order;
  }
  async markPaid(id) {
    await this.store.transaction(async tx => {
      const order = await tx.get('mock_orders', id);
      assert(order, 'NOT_FOUND', 'Order not found', 404);
      await tx.set('mock_orders', id, { ...order, paid: true, status: 'processing', transaction_id: `mock-${id}` });
    });
  }
}

export class PersistentMockMeta {
  constructor(store) { this.store = store; }
  async send(to, message) {
    const result = { id: `mock-message-${randomUUID()}` };
    await this.store.transaction(tx => tx.set('mock_messages', result.id, { to, message, ...result, createdAt: Date.now() }));
    return result;
  }
  async history(to) {
    return this.store.transaction(async tx => (await tx.list('mock_messages')).filter(m => m.to === to).sort((a, b) => a.createdAt - b.createdAt));
  }
}
