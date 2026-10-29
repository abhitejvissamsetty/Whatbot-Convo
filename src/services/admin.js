import { assert, hashPassword, checkPassword, text } from '../security/core.js';
import { audit, integrationRevision } from './settings.js';
import { digest, enqueue } from './data.js';
import { providerDefinition, validateEndpoint } from '../ai/providers.js';

const safeOrder = ({ paymentUrl: _paymentUrl, ...order }) => order;
const safeFlow = flow => ({ id: flow.id, customerId: flow.customerId, state: flow.state, screen: flow.screen, createdAt: flow.createdAt, expiresAt: flow.expiresAt, orderId: flow.orderId || null, items: flow.lines.map((line, i) => ({ ...line, name: flow.displayLines?.[i]?.name || 'Selected product' })), quote: flow.quote || null });
export class Admin {
  constructor(context) { Object.assign(this, context); }
  async overview() {
    return this.store.transaction(async tx => {
      const conversations = await tx.list('conversations'), messages = await tx.list('messages'), orders = await tx.list('orders'), flows = await tx.list('flows'), outbox = await tx.list('outbox'), jobs = await tx.list('jobs');
      const paid = orders.filter(o => o.paymentState === 'PAID_VERIFIED');
      const revenue = {};
      for (const order of paid) revenue[order.currency] = Number(((revenue[order.currency] || 0) + Number(order.total)).toFixed(2));
      const days = Array.from({ length: 7 }, (_, i) => new Date(this.now() - (6 - i) * 86400000).toISOString().slice(0, 10));
      return {
        storeName: this.config.storeName, mode: this.config.mode, assistantEnabled: this.config.assistantEnabled, notificationsEnabled: this.config.notificationsEnabled,
        totals: { conversations: conversations.length, waiting: conversations.filter(c => c.handoff && !c.agentId).length, orders: orders.length, paid: paid.length, pendingPayments: orders.filter(o => o.paymentState === 'PAYMENT_PENDING').length, activeCheckouts: flows.filter(f => f.expiresAt > this.now() && !['ORDER_PENDING', 'CANCELLED', 'EXPIRED'].includes(f.state)).length, messagesSent: outbox.filter(o => o.status === 'sent').length, attention: jobs.filter(j => j.status === 'failed').length + outbox.filter(o => ['blocked', 'uncertain'].includes(o.status)).length, conversion: orders.length ? Math.round(paid.length / orders.length * 100) : 0 },
        revenue,
        chart: days.map(day => ({ day, incoming: messages.filter(m => m.direction === 'in' && new Date(m.createdAt).toISOString().slice(0, 10) === day).length, outgoing: messages.filter(m => m.direction === 'out' && new Date(m.createdAt).toISOString().slice(0, 10) === day).length })),
        recentOrders: orders.sort((a, b) => b.createdAt - a.createdAt).slice(0, 5).map(safeOrder),
        activity: (await tx.list('audit')).sort((a, b) => b.createdAt - a.createdAt).slice(0, 5),
        worker: await tx.get('settings', 'worker-health') || null,
      };
    });
  }
  async ordersList() { return this.store.transaction(async tx => (await tx.list('orders')).sort((a, b) => b.createdAt - a.createdAt).map(safeOrder)); }
  async flowsList() { return this.store.transaction(async tx => (await tx.list('flows')).sort((a, b) => b.createdAt - a.createdAt).map(safeFlow)); }
  async cancelFlow(flowId, user) {
    return this.store.transaction(async tx => {
      const flow = await tx.get('flows', flowId);
      assert(flow, 'NOT_FOUND', 'Checkout not found', 404);
      assert(flow.state !== 'ORDER_PENDING' && !(await tx.get('orders', flowId)), 'ORDER_EXISTS', 'An order already exists. Manage it in WooCommerce.', 409);
      await tx.set('flows', flow.id, { ...flow, state: 'CANCELLED', expiresAt: this.now() });
      await audit(tx, user, 'checkout.cancelled', flow.id, this.now());
      return { ok: true };
    });
  }
  async reconcile(orderId, user, requestId) {
    return this.store.transaction(async tx => {
      const orders = await tx.list('orders');
      const selected = orderId === 'all' ? orders.sort((a, b) => b.createdAt - a.createdAt).slice(0, 200) : orders.filter(o => Number(o.wcOrderId) === Number(orderId));
      assert(selected.length > 0, 'NOT_FOUND', 'No linked orders to reconcile', 404);
      for (const order of selected) await enqueue(tx, `manual:${order.wcOrderId}:${digest(requestId)}`, 'reconcile', { orderId: order.wcOrderId }, this.now());
      await audit(tx, user, 'orders.reconciliation_queued', orderId, this.now());
      return { queued: selected.length };
    });
  }
  async queue() {
    return this.store.transaction(async tx => ({
      jobs: (await tx.list('jobs')).sort((a, b) => b.createdAt - a.createdAt).slice(0, 200).map(j => ({ id: j.id, type: j.type, status: j.status, attempts: j.attempts, availableAt: j.availableAt, createdAt: j.createdAt, errorCode: j.errorCode || null })),
      outbox: (await tx.list('outbox')).sort((a, b) => b.createdAt - a.createdAt).slice(0, 200).map(o => ({ id: o.id, conversationId: o.conversationId, type: o.message.type, event: o.message.event || null, status: o.status, createdAt: o.createdAt, blockedReason: o.blockedReason || null, errorCode: o.errorCode || null, resolution: o.resolution || null })),
    }));
  }
  async resolveDelivery(outboxId, input, user) {
    const note = text(input.note, 'Review note', 500);
    assert(note.length >= 10 && ['provider_confirmed', 'closed_without_resend'].includes(input.resolution), 'INVALID_REVIEW', 'Select a resolution and add a meaningful review note');
    return this.store.transaction(async tx => {
      const item = await tx.get('outbox', outboxId);
      assert(item?.status === 'uncertain', 'INVALID_OUTBOX', 'Only uncertain deliveries can be reviewed', 409);
      await tx.set('outbox', item.id, { ...item, status: 'resolved', resolution: input.resolution, reviewedAt: this.now(), reviewedBy: user.id });
      await audit(tx, user, 'delivery.reviewed', item.id, this.now(), [input.resolution]);
      await tx.set('settings', `review:${digest(item.id)}`, { note, reviewer: user.id, createdAt: this.now() });
      return { ok: true };
    });
  }
  async team() { return this.store.transaction(async tx => (await tx.list('operators')).map(({ passwordHash: _passwordHash, ...user }) => user).sort((a, b) => a.email.localeCompare(b.email))); }
  async updateMember(memberId, input, actor) {
    return this.store.transaction(async tx => {
      const member = await tx.get('operators', memberId);
      assert(member, 'NOT_FOUND', 'Team member not found', 404);
      assert(Object.keys(input).every(k => ['role', 'enabled', 'password'].includes(k)), 'INVALID_INPUT', 'Unsupported team change');
      const next = { ...member };
      if (input.role !== undefined) { assert(['admin', 'operator'].includes(input.role), 'INVALID_ROLE', 'Invalid role'); next.role = input.role; }
      if (input.enabled !== undefined) { assert(typeof input.enabled === 'boolean', 'INVALID_INPUT', 'Invalid account status'); next.enabled = input.enabled; }
      assert(memberId !== actor.id || (next.enabled && next.role === 'admin'), 'SELF_LOCKOUT', 'You cannot disable or demote your own administrator account', 409);
      const otherAdmins = (await tx.list('operators')).filter(u => u.id !== memberId && u.role === 'admin' && u.enabled);
      assert(otherAdmins.length || next.enabled && next.role === 'admin', 'LAST_ADMIN', 'Keep at least one active administrator', 409);
      if (input.password !== undefined) next.passwordHash = hashPassword(input.password);
      await tx.set('operators', memberId, next);
      if (input.password !== undefined || !next.enabled || next.role !== member.role) for (const s of await tx.list('sessions')) if (s.operatorId === memberId) await tx.delete('sessions', s.id);
      await audit(tx, actor, 'team.updated', member.email, this.now(), Object.keys(input));
      return { ok: true, reauthenticate: input.password !== undefined && actor.id === memberId };
    });
  }
  async changePassword(user, currentPassword, password) {
    const hash = hashPassword(password);
    await this.store.transaction(async tx => {
      const member = await tx.get('operators', user.id);
      assert(checkPassword(currentPassword, member.passwordHash), 'INVALID_PASSWORD', 'Current password is incorrect', 403);
      await tx.set('operators', member.id, { ...member, passwordHash: hash });
      for (const session of await tx.list('sessions')) if (session.operatorId === user.id) await tx.delete('sessions', session.id);
      await audit(tx, user, 'account.password_changed', user.email, this.now());
    });
    return { ok: true, reauthenticate: true };
  }
  async auditList() { return this.store.transaction(async tx => (await tx.list('audit')).sort((a, b) => b.createdAt - a.createdAt).slice(0, 200)); }
  async system() {
    const deployment = await this.settings.deployment();
    const checks = await this.store.transaction(async tx => {
      const result = {};
      for (const name of ['woocommerce', 'whatsapp', 'ai']) {
        const check = await tx.get('settings', `integration:${name}`);
        result[name] = check?.credentialRevision === integrationRevision(this.config, name) ? { status: check.status, message: check.message, checkedAt: check.checkedAt } : null;
      }
      return result;
    });
    return {
      mode: this.config.mode, environment: this.config.integrationEnvironment, persistence: this.config.storeDriver, publicUrl: this.config.publicUrl,
      runtime: process.version, uptime: Math.floor(process.uptime()), restartRequired: deployment.restartRequired,
      webhooks: { whatsapp: `${this.config.publicUrl}/api/webhooks/whatsapp`, flows: `${this.config.publicUrl}/api/flows/data`, woocommerce: `${this.config.publicUrl}/api/webhooks/woocommerce` },
      integrations: ['woocommerce', 'whatsapp', 'ai'].map(name => {
        const selected = providerDefinition(deployment.ai.savedProvider);
        let local = false;
        try { local = validateEndpoint(selected.baseEnv ? deployment.fields.find(f => f.key === selected.baseEnv)?.value || selected.endpoint : selected.endpoint).local; } catch { /* Incomplete draft. */ }
        const required = deployment.fields.filter(f => f.group === name && (name !== 'ai' ? f.key !== 'FLOW_PRIVATE_KEY_PASSPHRASE' : f.key === 'AI_PROVIDER' || f.provider === deployment.ai.savedProvider && (!f.optional || f.secret && !local)));
        return { name, configured: required.every(f => f.configured), configuredCount: required.filter(f => f.configured).length, requiredCount: required.length, status: this.config.mode === 'mock' ? 'mock' : required.every(f => f.configured) ? 'configured_unverified' : 'incomplete', check: checks[name], ...(name === 'ai' ? { provider: deployment.ai.activeProvider, providerName: providerDefinition(deployment.ai.activeProvider).name, model: deployment.ai.activeModel, savedProvider: deployment.ai.savedProvider } : {}) };
      }),
      worker: await this.store.transaction(tx => tx.get('settings', 'worker-health')) || null,
    };
  }
}
