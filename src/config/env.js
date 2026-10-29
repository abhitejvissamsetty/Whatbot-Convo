import { readFileSync } from 'node:fs';
import { providerOptions, aiSelection, providerDefinition } from '../ai/providers.js';
import { validateLiveSecurity } from '../security/deployment.js';

export function config(env = process.env) {
  const mode = env.APP_MODE || 'mock';
  if (!['mock', 'live'].includes(mode)) throw new Error('APP_MODE must be mock or live');
  const number = (key, fallback) => {
    const value = Number(env[key] || fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${key}`);
    return value;
  };
  const c = {
    envPath: env.CONFIG_ENV_PATH, storeName: env.STORE_NAME || 'Store Desk', assistantEnabled: env.ASSISTANT_ENABLED !== 'false', notificationsEnabled: env.NOTIFICATIONS_ENABLED !== 'false',
    mode, production: env.NODE_ENV === 'production', host: env.HOST || '127.0.0.1',
    port: number('PORT', 3000), publicUrl: env.PUBLIC_URL || 'http://localhost:3000',
    storeDriver: env.STORE_DRIVER || (mode === 'mock' ? 'memory' : 'mysql'), mysqlUrl: env.MYSQL_URL,
    requirePersistence: env.REQUIRE_PERSISTENCE === 'true',
    metaSecret: env.META_APP_SECRET || (mode === 'mock' ? 'local-meta-secret-change-me' : ''),
    verifyToken: env.META_VERIFY_TOKEN || (mode === 'mock' ? 'local-verify-token-change-me' : ''),
    wooWebhookSecret: env.WOO_WEBHOOK_SECRET || (mode === 'mock' ? 'local-woo-secret-change-me' : ''),
    graphVersion: env.META_GRAPH_VERSION, metaToken: env.META_TOKEN, phoneId: env.META_PHONE_NUMBER_ID,
    flowId: env.META_FLOW_ID, flowPrivateKeyPath: env.FLOW_PRIVATE_KEY_PATH || '', privateKey: env.FLOW_PRIVATE_KEY_PATH ? readFileSync(env.FLOW_PRIVATE_KEY_PATH, 'utf8') : null,
    keyPassphrase: env.FLOW_PRIVATE_KEY_PASSPHRASE || undefined,
    aiProvider: env.AI_PROVIDER || 'openai', anthropicVersion: env.ANTHROPIC_VERSION || '2026-10-21',
    wooUrl: env.WOO_URL, wooKey: env.WOO_KEY, wooSecret: env.WOO_SECRET, bridgeSecret: env.WOO_BRIDGE_SECRET,
    templates: JSON.parse(env.META_TEMPLATES || '{}'), flowTtl: number('FLOW_TTL_MINUTES', 30) * 60000,
    retentionDays: number('RETENTION_DAYS', 30), aiDailyLimit: number('AI_DAILY_TURN_LIMIT', 50),
    aiMaxTools: number('AI_MAX_TOOL_CALLS', 8), aiMaxOutput: number('AI_MAX_OUTPUT_TOKENS', 600),
    reconcileInterval: number('RECONCILE_INTERVAL_SECONDS', 300) * 1000,
    integrationEnvironment: env.INTEGRATION_ENVIRONMENT || 'staging',
    mockEmail: env.MOCK_OPERATOR_EMAIL, mockPassword: env.MOCK_OPERATOR_PASSWORD,
  };
  for (const provider of providerOptions()) {
    c[provider.keyConfig] = env[provider.keyEnv];
    c[provider.modelConfig] = env[provider.modelEnv];
    if (provider.baseConfig) c[provider.baseConfig] = env[provider.baseEnv] || provider.endpoint;
  }
  providerDefinition(c.aiProvider);
  if (!['memory', 'mysql'].includes(c.storeDriver)) throw new Error('Invalid STORE_DRIVER');
  if (c.requirePersistence && c.storeDriver !== 'mysql') throw new Error('Persistent storage required; set STORE_DRIVER=mysql');
  if (c.mode === 'mock' && c.host !== '127.0.0.1' && c.host !== '::1') throw new Error('Mock mode must bind to loopback');
  if (c.production && c.mode !== 'live') throw new Error('Production requires live mode');
  if (c.storeDriver === 'mysql' && !c.mysqlUrl) throw new Error('MYSQL_URL required');
  if (c.mode === 'live') {
    for (const key of ['metaSecret', 'verifyToken', 'wooWebhookSecret', 'graphVersion', 'metaToken', 'phoneId', 'flowId', 'privateKey', 'wooUrl', 'wooKey', 'wooSecret', 'bridgeSecret']) {
      if (!c[key]) throw new Error(`Missing live configuration: ${key}`);
    }
    aiSelection(c);
    if (c.storeDriver !== 'mysql') throw new Error('Live mode requires durable MySQL storage');
    validateLiveSecurity(c);
    if (!['staging', 'production'].includes(c.integrationEnvironment)) throw new Error('Invalid integration environment');
  }
  return c;
}
