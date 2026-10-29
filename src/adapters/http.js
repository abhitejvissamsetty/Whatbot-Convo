import { AppError } from '../security/core.js';
export async function request(url, { method = 'GET', headers = {}, body, timeout = 20000 } = {}) {
  let response;
  try {
    response = await fetch(url, { method, headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout), redirect: 'error' });
  } catch { throw new AppError('PROVIDER_UNAVAILABLE', 'Provider request timed out or failed', 503); }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const safe = ['quote_changed', 'invalid_cart', 'invalid_address', 'shipping_unavailable', 'invalid_coupon', 'out_of_stock'];
    if (safe.includes(payload.code)) throw new AppError(payload.code.toUpperCase(), typeof payload.message === 'string' ? payload.message.slice(0, 250) : 'Checkout changed or is unavailable. Please review your details.', 409);
    const error = new AppError('PROVIDER_ERROR', `Provider returned HTTP ${response.status}`, 502);
    error.deliveryCertain = true;
    error.providerStatus = response.status;
    throw error;
  }
  return payload;
}
