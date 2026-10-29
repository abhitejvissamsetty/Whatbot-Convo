import test from 'node:test';
import assert from 'node:assert/strict';
import { MetaCloud } from '../../src/adapters/metaCloud.js';
import { OpenAIResponses } from '../../src/adapters/openai.js';
import { WooRest } from '../../src/adapters/wooRest.js';
import { request } from '../../src/adapters/http.js';
import { config } from '../../src/config/env.js';

test('live adapters emit provider-specific payloads and bridge credentials stay server-side', async () => {
  const original = globalThis.fetch; const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push({ url: String(url), ...options, body: options.body && JSON.parse(options.body) });
    if (String(url).includes('graph.facebook')) return Response.json({ messages: [{ id: 'provider-message' }] });
    if (String(url).endsWith('/responses')) return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }] });
    if (String(url).endsWith('catalog-context')) return Response.json({ currency: 'INR' });
    if (String(url).includes('/products?')) return Response.json([{ id: 1, name: 'Real product', status: 'publish', price: '10.00', images: [] }]);
    return Response.json({});
  };
  try {
    const c = { ...config({}), graphVersion: 'test-version', phoneId: 'phone', flowId: 'flow', metaToken: 'meta-secret', wooUrl: 'https://store.example', wooKey: 'key', wooSecret: 'woo-secret', bridgeSecret: 'bridge-secret', openaiKey: 'ai-secret', model: 'configured-model' };
    const meta = new MetaCloud(c);
    await meta.send('919876543210', { type: 'flow', token: 'opaque' });
    assert.equal(seen[0].body.interactive.action.parameters.flow_action, 'data_exchange');
    assert.equal(seen[0].body.interactive.action.parameters.mode, 'draft');
    await meta.send('919876543210', { type: 'template', name: 'approved', language: 'en', parameters: ['5001', 'paid'] });
    assert.equal(seen[1].body.template.components[0].parameters[0].text, '5001');
    const ai = new OpenAIResponses(c); const result = await ai.respond([{ role: 'user', content: 'Hi' }], [], 'Policy');
    assert.equal(result.text, 'Hello'); assert.equal(seen[2].body.store, false); assert.equal(seen[2].body.model, 'configured-model');
    const woo = new WooRest(c); const products = await woo.search('Real');
    assert.equal(products[0].currency, 'INR');
    const bridgeCall = seen.find(s => s.url.endsWith('catalog-context')); assert.equal(bridgeCall.headers.Authorization, 'Bearer bridge-secret');
    assert(!seen.some(s => s.url.includes('secret')));
  } finally { globalThis.fetch = original; }
});
test('provider failures distinguish a response from uncertain network delivery', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{}', { status: 429 });
    await assert.rejects(request('https://provider.example'), e => e.deliveryCertain === true && e.providerStatus === 429);
    globalThis.fetch = async () => { throw new Error('network'); };
    await assert.rejects(request('https://provider.example'), e => e.code === 'PROVIDER_UNAVAILABLE' && !e.deliveryCertain);
  } finally { globalThis.fetch = original; }
});
test('untracked WooCommerce stock is never represented as invented inventory',async()=>{
  const woo=new WooRest({});
  assert.equal(woo.normalize({id:1,stock_status:'instock',stock_quantity:null}).stock,null);
  assert.equal(woo.normalize({id:1,stock_status:'outofstock',stock_quantity:null}).stock,0);
  woo.product=async()=>({id:1,type:'simple',purchasable:true,stock:null});
  assert.equal((await woo.availability({product_id:1,variation_id:0,quantity:20})).available,true);
  woo.product=async()=>({id:1,type:'simple',purchasable:true,stock:0});
  assert.equal((await woo.availability({product_id:1,variation_id:0,quantity:1})).available,false);
});
