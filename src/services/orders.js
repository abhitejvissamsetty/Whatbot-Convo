import { assert } from '../security/core.js';
import { outbound } from './data.js';
export class Orders {
  constructor(context) { Object.assign(this, context); }
  async paymentLink(customerId, orderId, requestId) {
    const link = await this.store.transaction(async tx => (await tx.list('orders')).find(o => Number(o.wcOrderId) === Number(orderId) && o.customerId === customerId));
    assert(link, 'ACCESS_DENIED', 'This order is not available for your account', 403);
    const order = await this.woo.order(orderId);
    assert(order.checkout_session_id === link.checkoutSessionId && order.total === link.total && order.currency === link.currency, 'ORDER_MISMATCH', 'Order details require support review', 502);
    assert(link.paymentState !== 'PAID_VERIFIED' && !order.paid && typeof order.payment_url === 'string' && order.payment_url.startsWith('https://') && ['pending', 'failed'].includes(order.status), 'NOT_PAYABLE', 'This order is not currently payable', 409);
    await this.store.transaction(tx => outbound(tx, `payment-retry:${link.id}:${requestId}`, customerId, { type: 'text', text: `Pay order #${order.id} securely: ${order.payment_url}`, event: 'payment_pending', orderId: order.id, orderStatus: order.status }, this.now()));
    return { sent: true };
  }
  async reconcile(orderId) {
    const linked = await this.store.transaction(async tx => (await tx.list('orders')).find(o => Number(o.wcOrderId) === Number(orderId)));
    if (!linked) return;
    const remote = await this.woo.order(orderId);
    assert(remote.checkout_session_id === linked.checkoutSessionId, 'ORDER_MISMATCH', 'Order identity mismatch', 502);
    assert(remote.total === linked.total && remote.currency === linked.currency, 'ORDER_MISMATCH', 'Order amount mismatch', 502);
    return this.store.transaction(async tx => {
      const order = await tx.get('orders', linked.id);
      const paid = Boolean(remote.paid && remote.transaction_id);
      const newlyPaid = paid && order.paymentState !== 'PAID_VERIFIED';
      if (paid) order.paymentState = 'PAID_VERIFIED';
      else if (order.paymentState !== 'PAID_VERIFIED') order.paymentState = ['failed', 'cancelled', 'refunded'].includes(remote.status) ? remote.status.toUpperCase() : 'PAYMENT_PENDING';
      order.fulfillmentState = remote.status; order.updatedAt = this.now();
      await tx.set('orders', order.id, order);
      if (newlyPaid) await outbound(tx, `paid:${order.id}`, order.customerId, { type: 'text', text: `Payment verified for order #${remote.id}. ${remote.currency} ${remote.total}.`, event: 'payment_verified', orderId: remote.id, orderStatus: 'paid' }, this.now());
      if (['completed', 'cancelled', 'failed', 'refunded'].includes(remote.status) && remote.status !== linked.fulfillmentState) await outbound(tx, `status:${order.id}:${remote.status}`, order.customerId, { type: 'text', text: `Order #${remote.id} is ${remote.status}.`, event: 'order_status', orderId: remote.id, orderStatus: remote.status }, this.now());
    });
  }
}
