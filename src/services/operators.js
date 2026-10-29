import { AppError, assert, checkPassword, hashPassword, text, token } from '../security/core.js';
import { digest, id, outbound } from './data.js';
import { audit } from './settings.js';
export class Operators {
  constructor(context) { Object.assign(this, context); }
  async create(email, password, role = 'operator') {
    email = text(email, 'Email').toLowerCase();
    assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'INVALID_EMAIL', 'Invalid email');
    assert(['admin', 'operator'].includes(role), 'INVALID_ROLE', 'Invalid role');
    const passwordHash = hashPassword(password);
    return this.store.transaction(async tx => {
      assert(!(await tx.list('operators')).some(u => u.email === email), 'DUPLICATE_USER', 'Operator already exists', 409);
      const user = { id: id(), email, passwordHash, role, enabled: true, createdAt: this.now() };
      await tx.set('operators', user.id, user);
      return { id: user.id, email, role };
    });
  }
  async login(email, password) {
    const user = await this.store.transaction(async tx => (await tx.list('operators')).find(u => u.email === String(email).trim().toLowerCase() && u.enabled));
    // Run scrypt on a fixed dummy hash too, avoiding an obvious unknown-user timing branch.
    const valid = checkPassword(password, user?.passwordHash || `${'0'.repeat(32)}:${'0'.repeat(128)}`);
    assert(user && valid, 'INVALID_LOGIN', 'Invalid email or password', 401);
    const sessionToken = token(), csrf = token();
    await this.store.transaction(tx => tx.set('sessions', digest(sessionToken), { operatorId: user.id, csrf, expiresAt: this.now() + 8 * 3600000 }));
    return { sessionToken, csrf, user: { id: user.id, email: user.email, role: user.role } };
  }
  async authenticate(sessionToken) {
    return this.store.transaction(async tx => {
      const session = await tx.get('sessions', digest(sessionToken || ''));
      assert(session && session.expiresAt > this.now(), 'UNAUTHORIZED', 'Please sign in', 401);
      const user = await tx.get('operators', session.operatorId);
      assert(user?.enabled, 'UNAUTHORIZED', 'Account disabled', 401);
      return { session, user: { id: user.id, email: user.email, role: user.role } };
    });
  }
  async list() {
    return this.store.transaction(async tx => {
      const messages = await tx.list('messages');
      return (await tx.list('conversations')).map(c => ({ ...c, unreadHandoff: c.handoff && !c.agentId, lastMessage: messages.filter(m => m.conversationId === c.id).sort((a, b) => b.createdAt - a.createdAt)[0]?.text || '' })).sort((a, b) => b.lastInboundAt - a.lastInboundAt);
    });
  }
  async history(conversationId) {
    return this.store.transaction(async tx => {
      assert(await tx.get('conversations', conversationId), 'NOT_FOUND', 'Conversation not found', 404);
      return (await tx.list('messages')).filter(m => m.conversationId === conversationId).sort((a, b) => a.createdAt - b.createdAt).slice(-200);
    });
  }
  async action(conversationId, action, user, body = {}) {
    return this.store.transaction(async tx => {
      const conversation = await tx.get('conversations', conversationId);
      assert(conversation, 'NOT_FOUND', 'Conversation not found', 404);
      if (action === 'claim') {
        assert(!conversation.agentId || conversation.agentId === user.id || user.role === 'admin', 'ALREADY_ASSIGNED', 'Conversation is assigned to another operator', 409);
        conversation.handoff = true; conversation.agentId = user.id;
        const active = (await tx.list('handoffs')).find(h => h.conversationId === conversationId && !h.closedAt);
        if (active) await tx.set('handoffs', active.id, { ...active, agentId: user.id });
        else await tx.set('handoffs', id(), { conversationId, agentId: user.id, reason: 'Operator claimed', startedAt: this.now(), closedAt: null });
      } else {
        assert(conversation.agentId === user.id || user.role === 'admin', 'ACCESS_DENIED', 'Claim the conversation first', 403);
        if (action === 'reply') {
          assert(conversation.handoff, 'HANDOFF_REQUIRED', 'Claim the conversation first', 409);
          const reply = text(body.text, 'Message', 4000);
          const requestId = text(body.requestId, 'Request ID', 100);
          await outbound(tx, `operator:${user.id}:${conversationId}:${digest(requestId)}`, conversationId, { type: 'text', text: reply, operatorId: user.id }, this.now());
        } else if (action === 'release') conversation.agentId = null;
        else if (action === 'resume') {
          conversation.handoff = false; conversation.agentId = null;
          for (const h of await tx.list('handoffs')) if (h.conversationId === conversationId && !h.closedAt) await tx.set('handoffs', h.id, { ...h, closedAt: this.now() });
        } else throw new AppError('INVALID_ACTION', 'Unknown action');
      }
      await tx.set('conversations', conversationId, conversation);
      await audit(tx, user, `conversation.${action}`, digest(conversationId).slice(0, 12), this.now());
      return { ok: true };
    });
  }
  async metrics() {
    return this.store.transaction(async tx => {
      const counts = async collection => (await tx.list(collection)).reduce((out, r) => { const key = r.status || r.paymentState || 'total'; out[key] = (out[key] || 0) + 1; return out; }, {});
      const httpErrors = Object.fromEntries((await tx.list('usage')).filter(r => r.id.startsWith('http-error:')).map(r => [r.code, r.count]));
      return { httpErrors, jobs: await counts('jobs'), outbox: await counts('outbox'), events: await counts('events'), orders: await counts('orders'), handoffs: (await tx.list('conversations')).filter(c => c.handoff).length };
    });
  }
}
