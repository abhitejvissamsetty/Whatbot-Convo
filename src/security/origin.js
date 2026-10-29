const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

export function allowedOrigin(value, config) {
  if (typeof value !== 'string') return false;
  let origin, expected;
  try { origin = new URL(value); expected = new URL(config.publicUrl); }
  catch { return false; }
  if (value !== origin.origin) return false;
  if (origin.origin === expected.origin) return true;
  // Only the local HTTP demo may use equivalent loopback hostnames.
  // Live deployments retain the exact configured origin and CSRF checks.
  return config.mode === 'mock' && !config.production && origin.protocol === 'http:' && expected.protocol === 'http:' &&
    loopbackHosts.has(origin.hostname) && loopbackHosts.has(expected.hostname) && origin.port === expected.port;
}
