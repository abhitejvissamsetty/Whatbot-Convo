import { readFile, writeFile, rename, chmod, unlink, access, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createPrivateKey } from 'node:crypto';
import { assert } from '../security/core.js';
import { digest, id } from './data.js';
import { providerOptions, providerDefinition, aiSelection, validateEndpoint } from '../ai/providers.js';
import { httpsUrl, strongSecret } from '../security/deployment.js';

export const policyFields = {
  storeName: { label: 'Workspace name', type: 'string', max: 80 },
  assistantEnabled: { label: 'AI assistant', type: 'boolean' },
  notificationsEnabled: { label: 'Outbound delivery', type: 'boolean' },
  aiDailyLimit: { label: 'Daily turns per customer', type: 'number', min: 1, max: 1000 },
  aiMaxTools: { label: 'Tool calls per turn', type: 'number', min: 1, max: 8 },
  aiMaxOutput: { label: 'Maximum output tokens', type: 'number', min: 100, max: 4000 },
  flowTtl: { label: 'Checkout expiry (minutes)', type: 'number', min: 5, max: 120, factor: 60000 },
  retentionDays: { label: 'Transient data retention (days)', type: 'number', min: 1, max: 365 },
  reconcileInterval: { label: 'Reconciliation interval (seconds)', type: 'number', min: 30, max: 3600, factor: 1000 },
};
export const deploymentFields = {
  WOO_URL: { label: 'WooCommerce URL', group: 'woocommerce', runtime: 'wooUrl', type: 'url' },
  WOO_KEY: { label: 'REST consumer key', group: 'woocommerce', runtime: 'wooKey', secret: true },
  WOO_SECRET: { label: 'REST consumer secret', group: 'woocommerce', runtime: 'wooSecret', secret: true },
  WOO_BRIDGE_SECRET: { label: 'Bridge bearer secret', group: 'woocommerce', runtime: 'bridgeSecret', secret: true, min: 32 },
  WOO_WEBHOOK_SECRET: { label: 'Order webhook secret', group: 'woocommerce', runtime: 'wooWebhookSecret', secret: true },
  META_GRAPH_VERSION: { label: 'Graph API version', group: 'whatsapp', runtime: 'graphVersion' },
  META_PHONE_NUMBER_ID: { label: 'Phone number ID', group: 'whatsapp', runtime: 'phoneId' },
  META_TOKEN: { label: 'System user access token', group: 'whatsapp', runtime: 'metaToken', secret: true },
  META_APP_SECRET: { label: 'App signing secret', group: 'whatsapp', runtime: 'metaSecret', secret: true },
  META_VERIFY_TOKEN: { label: 'Webhook verification token', group: 'whatsapp', runtime: 'verifyToken', secret: true },
  META_FLOW_ID: { label: 'Checkout Flow ID', group: 'whatsapp', runtime: 'flowId' },
  FLOW_PRIVATE_KEY_PATH: { label: 'RSA private key path', group: 'whatsapp', runtime: 'flowPrivateKeyPath', type: 'path' },
  FLOW_PRIVATE_KEY_PASSPHRASE: { label: 'Private key passphrase', group: 'whatsapp', runtime: 'keyPassphrase', secret: true },
  AI_PROVIDER: { label: 'AI provider', group: 'ai', runtime: 'aiProvider', type: 'select', options: providerOptions().map(p => ({ value: p.id, label: p.name })) },
  ANTHROPIC_VERSION: { label: 'Anthropic API version', group: 'ai', runtime: 'anthropicVersion', provider: 'anthropic', optional: true },
};
for (const provider of providerOptions()) {
  deploymentFields[provider.keyEnv] = { label: `${provider.name} API key`, group: 'ai', runtime: provider.keyConfig, secret: true, provider: provider.id, optional: provider.local || provider.id === 'compatible' };
  deploymentFields[provider.modelEnv] = { label: 'Model ID', group: 'ai', runtime: provider.modelConfig, provider: provider.id, type: 'model' };
  if (provider.baseEnv) deploymentFields[provider.baseEnv] = { label: 'API base URL', group: 'ai', runtime: provider.baseConfig, provider: provider.id, type: 'ai-url' };
}
export function integrationRevision(config, group) {
  if (group === 'ai' || group === 'openai') {
    const provider = providerDefinition(config.aiProvider || 'openai');
    return digest([config.aiProvider || 'openai', config[provider.modelConfig] || '', config[provider.keyConfig] || '', provider.baseConfig ? config[provider.baseConfig] || provider.endpoint : provider.endpoint, provider.id === 'anthropic' ? config.anthropicVersion : null]);
  }
  return digest(Object.entries(deploymentFields).filter(([, field]) => field.group === group).map(([key, field]) => [key, config[field.runtime] || '']).concat(group === 'whatsapp' ? [['keyContent', config.privateKey || '']] : []));
}
export async function audit(tx, user, action, subject, now, fields = []) {
  await tx.set('audit', id(), { actorId: user.id, actorEmail: user.email, action, subject: String(subject).slice(0, 150), fields, createdAt: now });
}
function validateTemplates(templates) {
  assert(templates && typeof templates === 'object' && !Array.isArray(templates), 'INVALID_SETTINGS', 'Templates must be an object');
  const result = {};
  for (const [event, template] of Object.entries(templates)) {
    assert(['payment_pending', 'payment_verified', 'order_status'].includes(event), 'INVALID_SETTINGS', 'Unsupported template event');
    assert(template && typeof template.name === 'string' && /^[a-z0-9_]{1,100}$/.test(template.name) && typeof template.language === 'string' && /^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(template.language), 'INVALID_SETTINGS', 'Use a valid approved template name and language');
    result[event] = { name: template.name, language: template.language };
  }
  return result;
}
export class Settings {
  constructor(context) { Object.assign(this, context); this.envPath = context.envPath || this.config.envPath || resolve('.env'); this.fileTail = Promise.resolve(); }
  async editable() {
    try {
      await access(dirname(this.envPath), constants.W_OK);
      try { if ((await lstat(this.envPath)).isSymbolicLink()) return false; await access(this.envPath, constants.W_OK); } catch (error) { if (error.code !== 'ENOENT') return false; }
      return true;
    } catch { return false; }
  }
  async refresh() {
    const record = await this.store.transaction(tx => tx.get('settings', 'runtime'));
    if (record) Object.assign(this.config, record.values);
  }
  async read() {
    return this.store.transaction(async tx => {
      const saved = await tx.get('settings', 'runtime');
      const values = Object.fromEntries(Object.entries(policyFields).map(([key, field]) => [key, (saved?.values[key] ?? this.config[key]) / (field.factor || 1)]));
      for (const [key, field] of Object.entries(policyFields)) if (field.type !== 'number') values[key] = saved?.values[key] ?? this.config[key];
      const ai = providerDefinition(this.config.aiProvider || 'openai');
      return { revision: saved?.revision || 0, values, templates: saved?.values.templates ?? this.config.templates, fields: policyFields, storage: this.config.storeDriver, updatedAt: saved?.updatedAt || null, ai: { provider: this.config.aiProvider || 'openai', name: ai.name, model: this.config[ai.modelConfig] || '' } };
    });
  }
  async update(input, user) {
    assert(input && Number.isSafeInteger(input.revision) && input.values && typeof input.values === 'object' && !Array.isArray(input.values), 'INVALID_SETTINGS', 'Settings revision and values are required');
    const patch = {};
    for (const [key, value] of Object.entries(input.values)) {
      const field = policyFields[key];
      assert(Object.hasOwn(policyFields, key), 'INVALID_SETTINGS', 'Unknown setting');
      if (field.type === 'boolean') assert(typeof value === 'boolean', 'INVALID_SETTINGS', `${field.label} must be true or false`);
      if (field.type === 'string') assert(typeof value === 'string' && value.trim().length > 0 && value.length <= field.max, 'INVALID_SETTINGS', `Invalid ${field.label}`);
      if (field.type === 'number') assert(Number.isSafeInteger(value) && value >= field.min && value <= field.max, 'INVALID_SETTINGS', `${field.label} must be between ${field.min} and ${field.max}`);
      patch[key] = field.type === 'number' ? value * (field.factor || 1) : field.type === 'string' ? value.trim() : value;
    }
    if (input.templates !== undefined) patch.templates = validateTemplates(input.templates);
    await this.store.transaction(async tx => {
      const existing = await tx.get('settings', 'runtime');
      assert((existing?.revision || 0) === input.revision, 'SETTINGS_CONFLICT', 'Settings changed in another session. Reload before saving.', 409);
      await tx.set('settings', 'runtime', { values: { ...existing?.values, ...patch }, revision: input.revision + 1, updatedAt: this.now() });
      await audit(tx, user, 'settings.updated', 'runtime', this.now(), Object.keys(patch));
    });
    Object.assign(this.config, patch);
    return this.read();
  }
  async envDocument() {
    let content = '';
    try { content = await readFile(this.envPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const values = {};
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      values[match[1]] = value;
    }
    return { content, values, revision: digest(content) };
  }
  async deployment() {
    const document = await this.envDocument();
    const fields = Object.entries(deploymentFields).map(([key, field]) => {
      const pendingValue = document.values[key];
      const active = field.runtime ? this.config[field.runtime] : (key === 'FLOW_PRIVATE_KEY_PATH' ? Boolean(this.config.privateKey) : '');
      const configured = Boolean(pendingValue || active);
      return { key, label: field.label, group: field.group, provider: field.provider, optional: Boolean(field.optional), options: field.options, secret: Boolean(field.secret), type: field.type || 'text', configured, value: field.secret ? '' : pendingValue ?? (typeof active === 'string' ? active : ''), restartRequired: pendingValue !== undefined && field.runtime && String(pendingValue) !== String(active || '') };
    });
    return { revision: document.revision, fields, restartRequired: fields.some(f => f.restartRequired), editable: await this.editable(), ai: { activeProvider: this.config.aiProvider || 'openai', activeModel: this.config[providerDefinition(this.config.aiProvider || 'openai').modelConfig] || '', savedProvider: document.values.AI_PROVIDER || this.config.aiProvider || 'openai', providers: providerOptions() } };
  }
  async aiDraft(options = {}) {
    assert(options && typeof options === 'object' && !Array.isArray(options) && Object.keys(options).every(key => ['provider', 'apiKey', 'baseUrl', 'version'].includes(key)), 'INVALID_SETTINGS', 'Unsupported model discovery option');
    const document = await this.envDocument();
    const provider = options.provider || document.values.AI_PROVIDER || this.config.aiProvider || 'openai';
    const definition = providerDefinition(provider);
    const config = { ...this.config, aiProvider: provider };
    for (const [env, field] of Object.entries(deploymentFields)) if (field.group === 'ai' && document.values[env] !== undefined && !(field.secret && document.values[env] === '')) config[field.runtime] = document.values[env];
    if (options.apiKey) config[definition.keyConfig] = options.apiKey;
    if (definition.baseConfig && options.baseUrl !== undefined) config[definition.baseConfig] = options.baseUrl;
    if (options.version !== undefined) { assert(typeof options.version === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(options.version), 'INVALID_SETTINGS', 'Invalid Anthropic API version'); config.anthropicVersion = options.version; }
    return { config, selection: aiSelection(config, { requireModel: false }) };
  }
  async saveDeployment(input, user) {
    const previous = this.fileTail; let release;
    this.fileTail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      assert(await this.editable(), 'MANAGED_CONFIGURATION', 'This environment file is managed by your deployment. Update it through your deployment system.', 403);
      const document = await this.envDocument();
      assert(input?.revision === document.revision, 'SETTINGS_CONFLICT', 'Deployment configuration changed. Reload before saving.', 409);
      assert(input.values && typeof input.values === 'object' && !Array.isArray(input.values), 'INVALID_SETTINGS', 'Configuration values are required');
      const patch = {};
      for (const [key, value] of Object.entries(input.values)) {
        const field = deploymentFields[key];
        assert(Object.hasOwn(deploymentFields, key), 'INVALID_SETTINGS', 'This deployment setting cannot be changed through the panel');
        assert(typeof value === 'string' && value.length <= 4096 && !/[\r\n\x00']/.test(value), 'INVALID_SETTINGS', `${field.label} cannot contain a newline, null byte, or single quote`);
        if (field.secret && value === '') continue; // Blank means keep the existing secret.
        if (field.options) assert(field.options.some(option => option.value === value), 'INVALID_SETTINGS', 'Select a supported AI provider');
        if (field.type === 'model') assert(value.length <= 200 && !/[\s\x00-\x1f]/.test(value), 'INVALID_AI_MODEL', 'Use a model ID without spaces');
        if (field.type === 'ai-url' && value) validateEndpoint(value);
        if (key === 'ANTHROPIC_VERSION' && value) assert(/^\d{4}-\d{2}-\d{2}$/.test(value), 'INVALID_SETTINGS', 'Use an Anthropic API version in YYYY-MM-DD format');
        if (value && field.min) assert(value.length >= field.min, 'INVALID_SETTINGS', `${field.label} must contain at least ${field.min} characters`);
        if (key === 'WOO_BRIDGE_SECRET' && value) strongSecret(value, field.label);
        if (this.config.mode === 'live' && ['META_APP_SECRET', 'META_VERIFY_TOKEN', 'WOO_WEBHOOK_SECRET'].includes(key) && value) strongSecret(value, field.label);
        if (field.type === 'url' && value) {
          httpsUrl(value, field.label);
          if (this.config.mode === 'live' && key === 'WOO_URL') assert(httpsUrl(value) === httpsUrl(this.config.wooUrl), 'STORE_CHANGE_REQUIRES_MIGRATION', 'Changing the connected store requires a separate database or a reviewed migration');
        }
        if (this.config.mode === 'live' && key === 'META_PHONE_NUMBER_ID') assert(value === this.config.phoneId, 'STORE_CHANGE_REQUIRES_MIGRATION', 'Changing the WhatsApp phone requires a reviewed migration');
        if (key === 'META_GRAPH_VERSION' && value) assert(/^v\d+\.\d+$/.test(value), 'INVALID_SETTINGS', 'Graph version must look like vNN.N');
        if (['META_PHONE_NUMBER_ID', 'META_FLOW_ID'].includes(key) && value) assert(/^\d+$/.test(value), 'INVALID_SETTINGS', `${field.label} must be numeric`);
        if (key === 'FLOW_PRIVATE_KEY_PATH' && value) {
          assert(resolve(value).endsWith('.pem'), 'INVALID_SETTINGS', 'Use a PEM key file path');
          try { const key = createPrivateKey({ key: await readFile(resolve(value)), passphrase: input.values.FLOW_PRIVATE_KEY_PASSPHRASE || document.values.FLOW_PRIVATE_KEY_PASSPHRASE || this.config.keyPassphrase }); if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) throw new Error('Invalid key type'); }
          catch { assert(false, 'INVALID_SETTINGS', 'Private key file is unreadable or the passphrase is incorrect'); }
        }
        if (this.config.mode === 'live' && !field.secret && field.group !== 'ai') assert(value.trim().length > 0, 'INVALID_SETTINGS', 'Required live connection fields cannot be cleared');
        patch[key] = field.secret ? value : value.trim();
      }
      if (Object.keys(patch).some(key => deploymentFields[key].group === 'ai') && (this.config.mode === 'live' || Object.hasOwn(patch, 'AI_PROVIDER'))) {
        const effective = { ...this.config };
        for (const [key, value] of Object.entries({ ...document.values, ...patch })) if (deploymentFields[key]?.group === 'ai' && !(deploymentFields[key].secret && value === '')) effective[deploymentFields[key].runtime] = value;
        aiSelection(effective);
      }
      const previousStore = document.values.WOO_URL || this.config.wooUrl;
      if (patch.WOO_URL && previousStore && httpsUrl(patch.WOO_URL) !== httpsUrl(previousStore)) {
        const existingCredentials = ['WOO_KEY', 'WOO_SECRET', 'WOO_BRIDGE_SECRET'].some(key => document.values[key] || this.config[deploymentFields[key].runtime]);
        if (existingCredentials) assert(['WOO_KEY', 'WOO_SECRET', 'WOO_BRIDGE_SECRET'].every(key => patch[key]), 'STORE_CREDENTIALS_REQUIRED', 'Enter fresh WooCommerce credentials when changing the store; saved secrets cannot be forwarded to another store');
      }
      let content = document.content;
      for (const [key, value] of Object.entries(patch)) {
        const line = `${key}='${value}'`;
        const pattern = new RegExp(`^${key}=.*$`, 'gm');
        content = pattern.test(content) ? content.replace(pattern, () => line) : `${content.trimEnd()}\n${line}\n`;
      }
      const temporary = `${this.envPath}.${id()}.tmp`;
      try { await writeFile(temporary, content, { mode: 0o600, flag: 'wx' }); await rename(temporary, this.envPath); await chmod(this.envPath, 0o600); }
      finally { await unlink(temporary).catch(() => {}); }
      await this.store.transaction(tx => audit(tx, user, 'deployment.saved', 'environment', this.now(), Object.keys(patch)));
      return { ...await this.deployment(), saved: true, message: 'Configuration saved. Restart the API and worker to apply credential changes.' };
    } finally { release(); }
  }
}
