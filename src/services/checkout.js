import { assert, normalizeWa, text, token } from '../security/core.js';
import { id, outbound } from './data.js';

export class Checkout {
  constructor({ store, woo, config, now = Date.now }) { Object.assign(this, { store, woo, config, now }); }
  async validateLines(lines) {
    assert(Array.isArray(lines) && lines.length > 0 && lines.length <= 10, 'INVALID_CART', 'Select 1–10 product lines');
    const normalized = [];
    for (const line of lines) {
      assert(line && typeof line === 'object' && !Array.isArray(line), 'INVALID_CART', 'Invalid product line');
      assert(Number.isSafeInteger(line.product_id) && Number.isSafeInteger(line.quantity) && (line.variation_id === undefined || Number.isSafeInteger(line.variation_id)), 'INVALID_CART', 'Product identifiers and quantities must be integers');
      const value = { product_id: Number(line.product_id), variation_id: Number(line.variation_id || 0), quantity: Number(line.quantity) };
      assert(Number.isSafeInteger(value.product_id) && value.product_id > 0 && Number.isSafeInteger(value.variation_id) && value.variation_id >= 0 && Number.isSafeInteger(value.quantity) && value.quantity >= 1 && value.quantity <= 20, 'INVALID_CART', 'Invalid product or quantity');
      assert(!normalized.some(l => l.product_id === value.product_id && l.variation_id === value.variation_id), 'INVALID_CART', 'Combine duplicate product lines');
      assert((await this.woo.availability(value)).available, 'OUT_OF_STOCK', 'Choose an available product variation and quantity', 409);
      normalized.push(value);
    }
    return normalized;
  }
  async start(customerId, lines, requestKey = id()) {
    const approved = await this.validateLines(lines);
    const displayLines = [];
    for (const line of approved) {
      const product = await this.woo.product(line.product_id);
      const variant = line.variation_id ? (await this.woo.variations(line.product_id)).find(v => v.id === line.variation_id) : null;
      displayLines.push({ name: `${product.name}${variant ? ` — ${variant.name}` : ''}`, productId: line.product_id, variationId: line.variation_id });
    }
    return this.store.transaction(async tx => {
      const existing = (await tx.list('flows')).find(f => f.requestKey === requestKey && f.customerId === customerId && f.expiresAt > this.now());
      if (existing) return existing;
      const previous = await tx.get('carts', customerId);
      assert(await tx.get('customers', customerId), 'NOT_FOUND', 'Customer not found', 404);
      const cart = { customerId, revision: (previous?.revision || 0) + 1, lines: approved };
      await tx.set('carts', customerId, cart);
      const flow = { id: id(), token: token(), customerId, cartRevision: cart.revision, lines: approved, displayLines, state: 'FLOW_ACTIVE', screen: 'PRODUCT', expiresAt: this.now() + this.config.flowTtl, createdAt: this.now(), requestKey };
      await tx.set('flows', flow.id, flow);
      await outbound(tx, `flow:${flow.id}`, customerId, { type: 'flow', token: flow.token, conversational: true }, this.now());
      return flow;
    });
  }
  async session(tx, flowToken, customerId) {
    const flow = (await tx.list('flows')).find(f => f.token === flowToken);
    assert(flow, 'INVALID_SESSION', 'Checkout session not found', 403);
    assert(!['CANCELLED', 'EXPIRED'].includes(flow.state), 'EXPIRED_SESSION', 'Checkout is no longer active. Start checkout again.', 410);
    assert(!customerId || flow.customerId === customerId, 'INVALID_SESSION', 'Checkout session does not belong to this customer', 403);
    assert(flow.expiresAt > this.now(), 'EXPIRED_SESSION', 'Checkout session expired. Start checkout again.', 410);
    const cart = await tx.get('carts', flow.customerId);
    assert(flow.state === 'ORDER_PENDING' || cart?.revision === flow.cartRevision, 'STALE_CART', 'Cart changed. Start checkout again.', 409);
    return flow;
  }
  customer(data, flow) {
    const phone = normalizeWa(data.phone);
    assert(phone === flow.customerId, 'INVALID_PHONE', 'Use the WhatsApp number for this checkout');
    const email = String(data.email || '').trim();
    assert(!email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'INVALID_EMAIL', 'Enter a valid email');
    return { name: text(data.name, 'Name', 100), phone, email };
  }
  delivery(data) {
    const value = { address_1: text(data.address_1, 'Address'), address_2: String(data.address_2 || '').slice(0, 200), city: text(data.city, 'City', 100), state: text(data.state, 'State', 100), country: text(data.country, 'Country', 2).toUpperCase(), postcode: text(data.postcode, 'PIN/postcode', 20) };
    assert(/^[A-Z]{2}$/.test(value.country), 'INVALID_ADDRESS', 'Use a two-letter country code');
    assert(value.country === 'IN' ? /^[1-9]\d{5}$/.test(value.postcode) : /^[A-Za-z0-9 -]{3,12}$/.test(value.postcode), 'INVALID_ADDRESS', 'Enter a valid PIN/postcode');
    return value;
  }
  input(flow) { return { lines: flow.lines, customer: flow.customer, delivery: flow.delivery, shipping_method: flow.shippingMethod || '', coupon: flow.coupon || '' }; }
  async transition(flowToken, screen, data = {}, customerId) {
    return this.store.transaction(async tx => {
      const flow = await this.session(tx, flowToken, customerId);
      if (flow.state === 'ORDER_PENDING') return this.completeResponse(flow);
      assert(flow.screen === screen, 'INVALID_SCREEN', 'Checkout screen is out of sequence', 409);
      if (screen === 'PRODUCT') {
        const quantities = typeof data.quantity === 'string' ? data.quantity.split(',').map(v => Number(v.trim())) : flow.lines.map(l => l.quantity);
        assert(quantities.length === flow.lines.length, 'INVALID_CART', 'Enter one quantity per cart line, separated by commas');
        flow.lines = await this.validateLines(flow.lines.map((l, i) => ({ ...l, quantity: quantities[i] })));
        flow.screen = 'CUSTOMER';
      } else if (screen === 'CUSTOMER') {
        flow.customer = this.customer(data, flow); flow.screen = 'DELIVERY';
      } else if (screen === 'DELIVERY') {
        flow.delivery = this.delivery(data);
        flow.coupon = String(data.coupon || '').slice(0, 100);
        flow.shippingMethod = '';
        flow.quote = await this.woo.quote(this.input(flow));
        flow.shippingMethod = flow.quote.shipping_method;
        flow.screen = 'REVIEW'; flow.state = 'QUOTE_VALIDATED';
      } else if (screen === 'REVIEW') {
        assert(data.confirm === true, 'CONFIRMATION_REQUIRED', 'Explicit confirmation is required');
        if (data.shipping_method !== flow.shippingMethod) {
          assert(flow.quote.shipping_methods.some(m => m.id === data.shipping_method), 'SHIPPING_UNAVAILABLE', 'Select an available shipping method');
          flow.shippingMethod = data.shipping_method;
          flow.quote = await this.woo.quote(this.input(flow));
          await tx.set('flows', flow.id, flow);
          return this.response(flow, 'Shipping changed. Review the new total and confirm again.');
        }
        assert(data.quote_fingerprint === flow.quote?.fingerprint, 'STALE_QUOTE', 'Please review the latest quote before confirming.', 409);
        const fresh = await this.woo.quote(this.input(flow));
        if (fresh.fingerprint !== flow.quote.fingerprint) {
          flow.quote = fresh; flow.shippingMethod = fresh.shipping_method;
          await tx.set('flows', flow.id, flow);
          return this.response(flow, 'Prices, stock, or delivery changed. Review and confirm again.');
        }
        const sessionId = flow.id;
        // Bridge lookup recovers remote success after a local failure/timeout.
        let order = await this.woo.findOrder(sessionId, tx);
        if (!order) order = await this.woo.createOrder(sessionId, this.input(flow), fresh.fingerprint, tx);
        assert(order.checkout_session_id === sessionId, 'ORDER_MISMATCH', 'Order session mismatch', 502);
        assert(String(order.total) === String(fresh.total) && order.currency === fresh.currency, 'ORDER_MISMATCH', 'Order total mismatch; contact support', 502);
        assert(typeof order.payment_url === 'string' && order.payment_url.startsWith('https://'), 'ORDER_MISMATCH', 'Secure payment URL unavailable', 502);
        const existing = (await tx.list('orders')).find(o => Number(o.wcOrderId) === Number(order.id));
        assert(!existing || existing.flowSessionId === flow.id, 'ORDER_MISMATCH', 'Order already linked', 409);
        await tx.set('orders', flow.id, { checkoutSessionId: flow.id, flowSessionId: flow.id, customerId: flow.customerId, wcOrderId: order.id, paymentState: 'PAYMENT_PENDING', fulfillmentState: order.status, paymentUrl: order.payment_url, total: order.total, currency: order.currency, createdAt: this.now(), updatedAt: this.now() });
        flow.state = 'ORDER_PENDING'; flow.orderId = order.id;
        await outbound(tx, `payment-link:${flow.id}`, flow.customerId, { type: 'text', text: `Order #${order.id}: ${order.currency} ${order.total}. Pay securely: ${order.payment_url}`, event: 'payment_pending', orderId: order.id, orderStatus: 'pending' }, this.now());
      } else assert(false, 'INVALID_SCREEN', 'Unknown checkout screen');
      await tx.set('flows', flow.id, flow);
      return flow.state === 'ORDER_PENDING' ? this.completeResponse(flow) : this.response(flow);
    });
  }
  completeResponse(flow) { return { screen: 'SUCCESS', data: { extension_message_response: { params: { flow_token: flow.token, order_id: String(flow.orderId) } } } }; }
  response(flow, error = '') {
    if (flow.screen === 'PRODUCT') return { screen: 'PRODUCT', data: { summary: flow.lines.map((l, i) => `${flow.displayLines[i].name} × ${l.quantity}`).join('\n'), quantity: flow.lines.map(l => l.quantity).join(','), error } };
    if (flow.screen === 'CUSTOMER') return { screen: 'CUSTOMER', data: { phone: flow.customerId, error } };
    if (flow.screen === 'DELIVERY') return { screen: 'DELIVERY', data: { error } };
    const q = flow.quote;
    return { screen: 'REVIEW', data: { summary: q.lines.map(l => `${l.name} × ${l.quantity}: ${q.currency} ${l.total}`).join('\n') + `\nSubtotal: ${q.subtotal}\nDiscount: ${q.discount}\nShipping: ${q.shipping}${q.fees?.length ? q.fees.map(f => `\n${f.name}: ${f.total}`).join('') : ''}\nTax: ${q.tax}\nTotal: ${q.currency} ${q.total}`, shipping_methods: q.shipping_methods.map(m => ({ id: m.id, title: `${m.title} (${q.currency} ${m.total})` })), shipping_method: q.shipping_method, quote_fingerprint: q.fingerprint, error } };
  }
  async exchange(payload) {
    if (payload.action === 'ping') return { data: { status: 'active' } };
    if (payload.data?.error) return { data: { acknowledged: true } };
    assert(['INIT', 'data_exchange', 'BACK'].includes(payload.action), 'INVALID_ACTION', 'Unsupported Flow action');
    if (payload.action === 'INIT' || payload.action === 'BACK') {
      return this.store.transaction(async tx => {
        const flow = await this.session(tx, payload.flow_token);
        if (payload.action === 'BACK' && flow.state !== 'ORDER_PENDING') {
          const previous = { REVIEW: 'DELIVERY', DELIVERY: 'CUSTOMER', CUSTOMER: 'PRODUCT', PRODUCT: 'PRODUCT' };
          flow.screen = previous[flow.screen]; flow.state = 'FLOW_ACTIVE'; delete flow.quote;
          await tx.set('flows', flow.id, flow);
        }
        return flow.state === 'ORDER_PENDING' ? this.completeResponse(flow) : this.response(flow);
      });
    }
    try {
      // The encrypted protocol does not carry an independently verified WhatsApp ID.
      // The unguessable token is a short-lived capability bound to one customer/cart.
      return await this.transition(payload.flow_token, payload.screen, payload.data);
    } catch (error) {
      if (!error.status || error.status >= 500) throw error;
      return this.store.transaction(async tx => {
        const flow = await this.session(tx, payload.flow_token);
        return this.response(flow, error.message);
      });
    }
  }
}
