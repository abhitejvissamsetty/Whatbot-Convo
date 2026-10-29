import { request } from '../adapters/http.js';
import { assert } from '../security/core.js';
import { aiSelection } from './providers.js';

export async function listModels(config, options = {}) {
  const s = aiSelection(config, { ...options, requireModel: false });
  const headers = s.protocol === 'anthropic' ? { Authorization: `Bearer ${s.key}`, 'anthropic-version': s.version } : s.protocol === 'gemini' ? { 'x-goog-api-key': s.key } : s.key ? { Authorization: `Bearer ${s.key}` } : {};
  const models = [];
  let cursor = null, more = false;
  for (let page = 0; page < 5; page++) {
    const params = new URLSearchParams();
    if (s.protocol === 'anthropic') { params.set('limit', '100'); if (cursor) params.set('after_id', cursor); }
    if (s.protocol === 'gemini') { params.set('pageSize', '100'); if (cursor) params.set('pageToken', cursor); }
    const payload = await request(`${s.baseUrl}/models${params.size ? `?${params}` : ''}`, { headers, timeout: 6000 });
    const items = s.protocol === 'gemini' ? payload.models : payload.data;
    assert(Array.isArray(items), 'PROVIDER_RESPONSE', 'Provider returned an invalid model list', 502);
    for (const item of items) {
      if (s.protocol === 'gemini' && item.supportedGenerationMethods && !item.supportedGenerationMethods.includes('generateContent')) continue;
      if (item.active === false || ['retired', 'deprecated'].includes(item.lifecycle)) continue;
      if (s.provider === 'openrouter' && Array.isArray(item.supported_parameters) && !item.supported_parameters.includes('tools')) continue;
      const rawId = item.id || item.name;
      if (typeof rawId !== 'string' || !rawId || rawId.length > 200) continue;
      models.push({ id: s.protocol === 'gemini' ? rawId.replace(/^models\//, '') : rawId, name: item.display_name || item.displayName || item.name || rawId, toolSupport: item.capabilities?.tool_use?.supported === true || item.supported_parameters?.includes('tools') ? 'reported' : 'unverified' });
    }
    const next = s.protocol === 'gemini' ? payload.nextPageToken : s.protocol === 'anthropic' && payload.has_more ? payload.last_id : null;
    more = Boolean(next && next !== cursor);
    if (!next || next === cursor) break;
    cursor = next;
  }
  const unique = [...new Map(models.map(m => [m.id, m])).values()].sort((a, b) => a.id.localeCompare(b.id));
  return { provider: s.provider, models: unique.slice(0, 1000), truncated: unique.length > 1000 || more, message: 'Model discovery is read-only. Select a model that supports function/tool calling; discovery does not verify generation or store behavior.' };
}
export async function checkAI(config) {
  const s = aiSelection(config);
  // OpenAI's retrieve endpoint verifies access to the exact configured model.
  if (s.provider === 'openai') {
    const model = await request(`${s.baseUrl}/models/${encodeURIComponent(s.model)}`, { headers: { Authorization: `Bearer ${s.key}` } });
    assert(model.id === s.model, 'PROVIDER_RESPONSE', 'Model identity did not match', 502);
  } else {
    const result = await listModels(config);
    assert(result.models.some(m => m.id === s.model), 'AI_MODEL_UNAVAILABLE', 'The selected model was not found in the accessible model list. Verify its ID and permissions.', 400);
  }
  return { provider: s.provider, model: s.model };
}
