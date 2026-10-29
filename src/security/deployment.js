import { assert } from './core.js';

export function httpsUrl(value, name = 'URL') {
  let url;
  try { url = new URL(value); } catch { assert(false, 'INVALID_SETTINGS', `${name} must be a valid HTTPS URL`); }
  assert(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'INVALID_SETTINGS', `${name} must use HTTPS without credentials, query, or fragment`);
  return url.href.replace(/\/+$/, '');
}

export function strongSecret(value, name) {
  assert(typeof value === 'string' && value.length >= 32 && value.length <= 4096 && !/change[-_ ]?me|replace[-_ ]?me|your[-_ ].*secret|example|demo-secret/i.test(value) && new Set(value).size >= 8,
    'UNSAFE_SECRET', `${name} must be a unique secret of at least 32 characters; sample values are not allowed`);
}

export function validateLiveSecurity(config) {
  httpsUrl(config.publicUrl, 'PUBLIC_URL');
  httpsUrl(config.wooUrl, 'WOO_URL');
  for (const key of ['metaSecret', 'verifyToken', 'wooWebhookSecret', 'bridgeSecret']) strongSecret(config[key], key);
}
