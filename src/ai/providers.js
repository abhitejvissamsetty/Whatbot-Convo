import { assert } from '../security/core.js';

export const providers = {
  openai: { name: 'OpenAI', protocol: 'responses', endpoint: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', modelEnv: 'OPENAI_MODEL', keyConfig: 'openaiKey', modelConfig: 'model' },
  anthropic: { name: 'Anthropic Claude', protocol: 'anthropic', endpoint: 'https://api.anthropic.com/v1', keyEnv: 'ANTHROPIC_API_KEY', modelEnv: 'ANTHROPIC_MODEL', keyConfig: 'anthropicKey', modelConfig: 'anthropicModel', versionEnv: 'ANTHROPIC_VERSION' },
  gemini: { name: 'Google Gemini', protocol: 'gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta', keyEnv: 'GEMINI_API_KEY', modelEnv: 'GEMINI_MODEL', keyConfig: 'geminiKey', modelConfig: 'geminiModel' },
  deepseek: { name: 'DeepSeek', protocol: 'chat', endpoint: 'https://api.deepseek.com', keyEnv: 'DEEPSEEK_API_KEY', modelEnv: 'DEEPSEEK_MODEL', keyConfig: 'deepseekKey', modelConfig: 'deepseekModel' },
  groq: { name: 'Groq', protocol: 'chat', endpoint: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', modelEnv: 'GROQ_MODEL', keyConfig: 'groqKey', modelConfig: 'groqModel' },
  openrouter: { name: 'OpenRouter', protocol: 'chat', endpoint: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', modelEnv: 'OPENROUTER_MODEL', keyConfig: 'openrouterKey', modelConfig: 'openrouterModel' },
  ollama: { name: 'Ollama', protocol: 'chat', endpoint: 'http://127.0.0.1:11434/v1', keyEnv: 'OLLAMA_API_KEY', modelEnv: 'OLLAMA_MODEL', keyConfig: 'ollamaKey', modelConfig: 'ollamaModel', baseEnv: 'OLLAMA_BASE_URL', baseConfig: 'ollamaBaseUrl', local: true },
  compatible: { name: 'Custom / OpenAI compatible', protocol: 'chat', endpoint: '', keyEnv: 'AI_API_KEY', modelEnv: 'AI_MODEL', keyConfig: 'compatibleKey', modelConfig: 'compatibleModel', baseEnv: 'AI_BASE_URL', baseConfig: 'compatibleBaseUrl' },
};
export const providerOptions = () => Object.entries(providers).map(([id, provider]) => ({ id, ...provider }));
export function providerDefinition(id) {
  assert(Object.hasOwn(providers, id), 'INVALID_AI_PROVIDER', 'Select a supported AI provider');
  return providers[id];
}
export function validateEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { assert(false, 'INVALID_AI_ENDPOINT', 'Enter a valid API base URL, including /v1 when required'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  assert(!url.username && !url.password && !url.search && !url.hash && (url.protocol === 'https:' || url.protocol === 'http:' && local), 'INVALID_AI_ENDPOINT', 'Use HTTPS, or HTTP for a loopback endpoint. Do not put credentials or query parameters in the URL.');
  return { url: url.toString().replace(/\/$/, ''), local };
}
export function aiSelection(config, { provider = config.aiProvider || 'openai', apiKey, model, baseUrl, requireModel = true, requireKey = true } = {}) {
  const definition = providerDefinition(provider);
  assert(!baseUrl || definition.baseConfig, 'INVALID_AI_ENDPOINT', 'This provider uses its fixed official API endpoint');
  const endpoint = validateEndpoint(baseUrl ?? (definition.baseConfig ? config[definition.baseConfig] || definition.endpoint : definition.endpoint));
  const key = apiKey || config[definition.keyConfig] || '';
  const selectedModel = model ?? config[definition.modelConfig] ?? '';
  assert(typeof selectedModel === 'string' && selectedModel.length <= 200 && !/[\s\x00-\x1f]/.test(selectedModel), 'INVALID_AI_MODEL', 'Use a valid model ID without spaces');
  if (requireModel) assert(selectedModel.length > 0, 'AI_MODEL_REQUIRED', `Select a model for ${definition.name}`);
  assert(typeof key === 'string' && key.length <= 4096 && !/[\r\n\x00]/.test(key), 'INVALID_AI_KEY', 'Invalid AI API key');
  if (requireKey && !(endpoint.local && ['ollama', 'compatible'].includes(provider))) assert(key.length > 0, 'AI_KEY_REQUIRED', `Configure an API key for ${definition.name}`);
  const version = config.anthropicVersion || '2026-10-21';
  if (definition.protocol === 'anthropic') assert(typeof version === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(version), 'INVALID_SETTINGS', 'Use an Anthropic API version in YYYY-MM-DD format');
  return { provider, ...definition, model: provider === 'gemini' ? selectedModel.replace(/^models\//, '') : selectedModel, key, baseUrl: endpoint.url, local: endpoint.local, version, maxOutput: config.aiMaxOutput || 600 };
}
