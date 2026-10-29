import { el, field, btn, infoBox, modal, bindForm, toast, badge } from './ui.js';

export async function configureAI(ctx) {
  const deployment = await ctx.api('deployment');
  const catalog = deployment.ai.providers;
  let selected = deployment.ai.savedProvider;
  let fields, draft = new Map(), discoveryVersion = 0;
  const container = el('div', { class: 'stack' });
  const providerControl = field('AI provider', 'AI_PROVIDER', { value: selected, options: catalog.map(p => ({ value: p.id, label: p.name })) });
  const form = el('form', {},
    infoBox('Choose the service and model for your assistant', 'Save your choice, then restart the API and worker to apply it. Each provider keeps its own credentials. Demo conversations remain simulated.'),
    providerControl, container,
    el('div', { class: 'form-note' }, 'Loading models makes an explicit, read-only request to the selected service using the key below. It does not generate text or create an order. Model availability does not guarantee tool-calling support.'),
    btn(deployment.editable ? 'Save AI configuration' : 'Managed by deployment', { type: 'submit', variant: 'primary', disabled: !deployment.editable, glyph: 'check' })
  );
  const metadata = key => deployment.fields.find(f => f.key === key);
  function remember() {
    if (!fields) return;
    draft.set(fields.provider.id, { key: fields.key.value, model: fields.manual.checked ? fields.modelInput.value : fields.modelSelect.value, baseUrl: fields.baseInput?.value, version: fields.versionInput?.value, manual: fields.manual.checked, models: fields.models });
  }
  function render() {
    discoveryVersion++;
    const provider = catalog.find(p => p.id === selected);
    const saved = draft.get(selected);
    const keyMeta = metadata(provider.keyEnv), modelMeta = metadata(provider.modelEnv);
    const currentModel = saved?.model ?? modelMeta.value;
    const keyField = field(`${provider.name} API key`, provider.keyEnv, { type: 'password', value: saved?.key || '', autoComplete: 'off', placeholder: keyMeta.configured ? 'Configured · leave blank to keep' : provider.local ? 'Optional for local Ollama' : 'Enter the provider API key', description: keyMeta.configured ? 'A key is stored securely and is never displayed.' : 'The key stays on your backend.' });
    const key = keyField.querySelector('input');
    const modelSelect = el('select', { name: 'modelChoice', 'aria-label': 'Available AI models' });
    const modelLabel = el('label', { class: 'field' }, el('span', {}, 'Model'), modelSelect);
    const manualLabel = field('Enter a model ID manually', 'manualModel', { type: 'checkbox', checked: Boolean(saved?.manual) });
    const manual = manualLabel.querySelector('input');
    const modelInputField = field('Model ID', provider.modelEnv, { value: currentModel, placeholder: 'Exact model ID from your service', maxLength: 200 });
    const modelInput = modelInputField.querySelector('input');
    const result = el('div', { class: 'ai-model-status', role: 'status', 'aria-live': 'polite' });
    const nodes = [keyField];
    let baseInput, versionInput;
    if (provider.baseEnv) {
      const f = field('API base URL', provider.baseEnv, { value: saved?.baseUrl ?? metadata(provider.baseEnv).value ?? provider.endpoint, required: true, description: 'Include the API prefix, such as /v1. HTTP is allowed only on localhost or loopback; remote endpoints require HTTPS.' });
      baseInput = f.querySelector('input'); nodes.push(f);
    }
    if (provider.versionEnv) {
      const f = field('Anthropic API version', provider.versionEnv, { value: saved?.version || metadata(provider.versionEnv).value, required: true, description: 'Use the API version supported by your Claude account.' });
      versionInput = f.querySelector('input'); nodes.push(f);
    }
    function setChoices(models, value) {
      modelSelect.replaceChildren(el('option', { value: '' }, models.length ? 'Select a model…' : 'Load models from your service…'));
      if (value && !models.some(m => m.id === value)) modelSelect.append(el('option', { value }, `${value} (saved / manually entered)`));
      for (const model of models) modelSelect.append(el('option', { value: model.id }, model.name && model.name !== model.id ? `${model.id} — ${model.name}` : model.id));
      modelSelect.value = value || '';
    }
    function updateMode() {
      modelLabel.hidden = manual.checked; modelSelect.disabled = manual.checked; modelSelect.required = !manual.checked;
      modelInputField.hidden = !manual.checked; modelInput.disabled = !manual.checked; modelInput.required = manual.checked;
      let local = provider.local;
      if (baseInput) { try { local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseInput.value).hostname); } catch { local = false; } }
      key.required = !keyMeta.configured && !local;
    }
    const load = btn('Load available models', { glyph: 'refresh', onClick: async () => {
      const version = ++discoveryVersion;
      result.textContent = `Reading available models from ${provider.name}…`;
      try {
        const options = { provider: selected };
        if (key.value) options.apiKey = key.value;
        if (baseInput) options.baseUrl = baseInput.value;
        if (versionInput) options.version = versionInput.value;
        const response = await ctx.api('ai/models', options);
        if (version !== discoveryVersion || selected !== provider.id) return;
        const existing = manual.checked ? modelInput.value : modelSelect.value;
        fields.models = response.models;
        setChoices(response.models, existing);
        result.replaceChildren(badge(response.models.length ? 'active' : 'pending', `${response.models.length} ${response.models.length === 1 ? 'model' : 'models'} loaded${response.truncated ? ' · partial list' : ''}`), el('p', {}, response.models.length ? 'Choose a tool-capable model above, or enter its ID manually. No generation was performed.' : 'No matching models were returned. You can enter a supported model ID manually.'));
      } catch (error) {
        if (version === discoveryVersion) result.textContent = `${error.message} You can still enter the model ID manually.`;
      }
    } });
    setChoices(saved?.models || [], currentModel);
    manual.addEventListener('change', () => { if (manual.checked) modelInput.value = modelSelect.value || modelInput.value; else if (modelInput.value) setChoices(fields.models, modelInput.value); updateMode(); });
    baseInput?.addEventListener('input', updateMode);
    fields = { provider, key, modelSelect, modelInput, manual, baseInput, versionInput, models: saved?.models || [] };
    container.replaceChildren(...nodes, el('div', { class: 'row wrap between' }, el('strong', { class: 'ai-selection-heading' }, 'Select your model'), load), modelLabel, manualLabel, modelInputField, result);
    updateMode();
  }
  providerControl.querySelector('select').addEventListener('change', event => { remember(); selected = event.target.value; render(); });
  bindForm(form, async () => {
    const values = { AI_PROVIDER: selected, [fields.provider.modelEnv]: fields.manual.checked ? fields.modelInput.value.trim() : fields.modelSelect.value };
    if (fields.key.value) values[fields.provider.keyEnv] = fields.key.value;
    if (fields.baseInput) values[fields.provider.baseEnv] = fields.baseInput.value.trim();
    if (fields.versionInput) values[fields.provider.versionEnv] = fields.versionInput.value.trim();
    await ctx.api('deployment', { revision: deployment.revision, values });
    document.querySelector('#modal').close();
    toast('AI configuration saved. Restart the API and worker to apply your provider and model.');
    await ctx.reload();
  });
  render();
  modal('AI provider & model', `Currently running: ${catalog.find(p => p.id === deployment.ai.activeProvider).name}${deployment.ai.activeModel ? ` · ${deployment.ai.activeModel}` : ' · no model configured'}`, form, { wide: true });
}
