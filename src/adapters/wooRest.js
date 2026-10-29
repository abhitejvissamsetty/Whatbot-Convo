import { request } from './http.js';
import { assert } from '../security/core.js';
import { httpsUrl } from '../security/deployment.js';
export class WooRest {
  constructor(config) { this.config = config; }
  async currency() {
    if (!this.currencyValue) {
      const data = await this.bridge('catalog-context');
      assert(typeof data.currency === 'string' && /^[A-Z]{3}$/.test(data.currency), 'PROVIDER_RESPONSE', 'Store currency unavailable', 502);
      this.currencyValue = data.currency;
    }
    return this.currencyValue;
  }
  async rest(path) {
    return request(`${httpsUrl(this.config.wooUrl, 'WOO_URL')}/wp-json/wc/v3/${path}`, { headers: { Authorization: `Basic ${Buffer.from(`${this.config.wooKey}:${this.config.wooSecret}`).toString('base64')}` } });
  }
  normalize(p) { return { id: p.id, product_id: p.parent_id || p.id, name: p.name || p.attributes?.map(a => a.option).join(' / '), type: p.type, status: p.status, price: p.price, currency: this.currencyValue, purchasable: p.purchasable, stock: p.stock_status === 'outofstock' ? 0 : p.stock_quantity ?? null, image: p.images?.[0]?.src || p.image?.src || null, attributes: p.attributes }; }
  async search(query, category = null, limit = 5) {
    await this.currency();
    const params = new URLSearchParams({ search: query, status: 'publish', per_page: String(Math.min(10, limit)) });
    if (category) params.set('category', category);
    return (await this.rest(`products?${params}`)).map(p => this.normalize(p));
  }
  async product(id) { await this.currency(); const p = await this.rest(`products/${Number(id)}`); assert(p.status === 'publish', 'NOT_FOUND', 'Product unavailable', 404); return this.normalize(p); }
  async variations(id) {
    await this.product(id);
    return (await this.rest(`products/${Number(id)}/variations?per_page=100&status=publish`)).map(v => this.normalize(v)).filter(v => v.purchasable && (v.stock === null || v.stock > 0));
  }
  async availability(line) {
    const p = await this.product(line.product_id);
    const v = line.variation_id ? (await this.variations(line.product_id)).find(v => v.id === line.variation_id) : p;
    const stock = v?.stock ?? p.stock;
    return { available: Boolean(v && v.purchasable && (stock === null || stock >= line.quantity) && (p.type !== 'variable' || line.variation_id)), stock: stock ?? null };
  }
  async bridge(path, body) {
    return request(`${httpsUrl(this.config.wooUrl, 'WOO_URL')}/wp-json/wa-commerce/v1/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${this.config.bridgeSecret}` }, body });
  }
  async quote(input) { return this.bridge('quote', input); }
  checkedOrder(order) {
    assert(order && Number.isSafeInteger(Number(order.id)) && Number(order.id) > 0, 'PROVIDER_RESPONSE', 'Invalid store order response', 502);
    if (order.payment_url !== null && order.payment_url !== undefined) {
      let url; try { url = new URL(order.payment_url); } catch { assert(false, 'PROVIDER_RESPONSE', 'Invalid store payment URL', 502); }
      assert(url.protocol === 'https:' && !url.username && !url.password && !url.hash && url.origin === new URL(this.config.wooUrl).origin, 'PROVIDER_RESPONSE', 'Payment URL must belong to the connected WooCommerce store', 502);
    }
    return order;
  }
  async findOrder(sessionId) { const order = (await this.bridge(`orders/${sessionId}`)).order; return order ? this.checkedOrder(order) : null; }
  async createOrder(sessionId, input, expected) { return this.checkedOrder(await this.bridge('orders', { checkout_session_id: sessionId, ...input, expected_fingerprint: expected })); }
  async order(id) { return this.checkedOrder(await this.bridge(`order-status/${Number(id)}`)); }
}
