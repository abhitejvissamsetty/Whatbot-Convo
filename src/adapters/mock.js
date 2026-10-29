import { AppError, assert } from '../security/core.js';
import { digest } from '../services/data.js';

// MySQL JSON storage can reorder object keys; equivalent quotes must hash equally.
const fingerprint = value => digest(JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v));

export class MockWoo {
  constructor() {
    this.products = [
      { id: 101, name: 'Cotton T-shirt', type: 'variable', status: 'publish', price: '499.00', currency: 'INR', stock: 20, purchasable: true, image: null, variations: [
        { id: 1001, product_id: 101, name: 'Blue / M', price: '499.00', stock: 8, purchasable: true },
        { id: 1002, product_id: 101, name: 'Blue / L', price: '549.00', stock: 5, purchasable: true },
      ] },
      { id: 102, name: 'Canvas Bag', type: 'simple', status: 'publish', price: '299.00', currency: 'INR', stock: 10, purchasable: true, image: null, variations: [] },
    ];
    this.orders = new Map(); this.sessions = new Map(); this.sequence = 5000; this.sent = [];
  }
  async search(query = '', _category = null, limit = 5) { return structuredClone(this.products.filter(p => p.status === 'publish' && p.name.toLowerCase().includes(query.toLowerCase())).slice(0, Math.min(limit, 10))); }
  async product(id) { const p = this.products.find(p => p.id === Number(id) && p.status === 'publish'); assert(p, 'NOT_FOUND', 'Product unavailable', 404); return structuredClone(p); }
  async variations(id) { return (await this.product(id)).variations.filter(v => v.purchasable && v.stock > 0); }
  async availability(line) {
    const p = await this.product(line.product_id);
    const v = line.variation_id ? p.variations.find(v => v.id === line.variation_id) : p;
    return { available: Boolean(v && v.purchasable && v.stock >= line.quantity && (p.type !== 'variable' || line.variation_id)), stock: v?.stock ?? 0 };
  }
  async quote(input) {
    const lines = [];
    for (const item of input.lines) {
      assert((await this.availability(item)).available, 'OUT_OF_STOCK', 'Stock changed. Select another quantity or variation.', 409);
      const product = await this.product(item.product_id);
      const variant = item.variation_id ? product.variations.find(v => v.id === item.variation_id) : product;
      lines.push({ ...item, name: `${product.name}${item.variation_id ? ` — ${variant.name}` : ''}`, price: variant.price, total: (Number(variant.price) * item.quantity).toFixed(2) });
    }
    assert(input.delivery.postcode !== '000000', 'SHIPPING_UNAVAILABLE', 'Delivery is unavailable for this PIN code');
    const methods = [{ id: 'flat_rate:1', title: 'Standard shipping', total: '50.00' }];
    assert(!input.shipping_method || methods.some(m => m.id === input.shipping_method), 'SHIPPING_UNAVAILABLE', 'Select an available shipping method');
    const subtotal = lines.reduce((sum, line) => sum + Number(line.total), 0);
    assert(!input.coupon || input.coupon === 'DEMO10', 'INVALID_COUPON', 'Coupon is invalid');
    const discount = input.coupon ? Math.round(subtotal * 10) / 100 : 0;
    const quote = { lines, shipping_methods: methods, shipping_method: input.shipping_method || methods[0].id, subtotal: subtotal.toFixed(2), discount: discount.toFixed(2), shipping: '50.00', tax: '0.00', total: (subtotal - discount + 50).toFixed(2), currency: 'INR' };
    return { ...quote, fingerprint: fingerprint({ ...quote, delivery: input.delivery, customer: input.customer, coupon: input.coupon || '' }) };
  }
  async findOrder(sessionId) { const id = this.sessions.get(sessionId); return id ? structuredClone(this.orders.get(id)) : null; }
  async createOrder(sessionId, input, expected) {
    const existing = await this.findOrder(sessionId); if (existing) return existing;
    const quote = await this.quote(input);
    assert(quote.fingerprint === expected, 'QUOTE_CHANGED', 'Your quote changed. Review and confirm again.', 409);
    const id = ++this.sequence;
    const order = { id, status: 'pending', paid: false, transaction_id: '', total: quote.total, currency: quote.currency, lines: quote.lines, checkout_session_id: sessionId, payment_url: `https://checkout.example.invalid/order-pay/${id}?key=mock`, created_at: Date.now() };
    this.orders.set(id, order); this.sessions.set(sessionId, id);
    return structuredClone(order);
  }
  async order(id) { const order = this.orders.get(Number(id)); if (!order) throw new AppError('NOT_FOUND', 'Order not found', 404); return structuredClone(order); }
  async markPaid(id) { const order = this.orders.get(Number(id)); assert(order, 'NOT_FOUND', 'Order not found', 404); Object.assign(order, { paid: true, status: 'processing', transaction_id: `mock-${id}` }); }
}
export class MockMeta {
  constructor() { this.sent = []; }
  async send(to, message) { const result = { id: `mock-message-${this.sent.length + 1}` }; this.sent.push({ to, message: structuredClone(message), ...result }); return result; }
  async history(to) { return structuredClone(this.sent.filter(m => m.to === to)); }
}
