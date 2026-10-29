import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../src/config/env.js';
import { aiSelection, providerOptions } from '../../src/ai/providers.js';
import { createAIAdapter, AIClient, AnthropicMessages, GeminiContent, CompatibleChat } from '../../src/ai/adapters.js';
import { OpenAIResponses } from '../../src/adapters/openai.js';
import { listModels } from '../../src/ai/models.js';
import { setup, wa } from '../helpers.js';

const tools=[{type:'function',name:'get_product',description:'Read a product',strict:true,parameters:{type:'object',properties:{product_id:{type:'integer'}},required:['product_id'],additionalProperties:false}}];
const initial=[{role:'user',content:'Show the Canvas Bag'}];
async function withFetch(handler,run){const original=globalThis.fetch;globalThis.fetch=handler;try{return await run();}finally{globalThis.fetch=original;}}

test('provider selection is backward compatible, supports eight services, and validates endpoint/key/model',()=>{
  const openai=config({OPENAI_API_KEY:'openai-key',OPENAI_MODEL:'account-model'});
  assert.equal(openai.aiProvider,'openai');assert(createAIAdapter(openai) instanceof OpenAIResponses);
  assert.equal(providerOptions().length,8);
  const claude=config({AI_PROVIDER:'anthropic',ANTHROPIC_API_KEY:'claude-key',ANTHROPIC_MODEL:'account-claude'});
  assert(createAIAdapter(claude) instanceof AnthropicMessages);assert.equal(aiSelection(claude).key,'claude-key');assert.equal(claude.openaiKey,undefined);
  assert(createAIAdapter(config({AI_PROVIDER:'gemini',GEMINI_API_KEY:'gemini-key',GEMINI_MODEL:'account-gemini'})) instanceof GeminiContent);
  assert(createAIAdapter(config({AI_PROVIDER:'ollama',OLLAMA_MODEL:'local-model'})) instanceof CompatibleChat);
  for(const endpoint of ['http://remote.example/v1','https://user:pass@example.test/v1','https://example.test/v1?key=secret'])assert.throws(()=>aiSelection(config({AI_PROVIDER:'compatible',AI_BASE_URL:endpoint,AI_MODEL:'m',AI_API_KEY:'k'})),e=>e.code==='INVALID_AI_ENDPOINT');
  assert.throws(()=>aiSelection(config({AI_PROVIDER:'anthropic',ANTHROPIC_MODEL:'m'})),e=>e.code==='AI_KEY_REQUIRED');
  assert.throws(()=>config({AI_PROVIDER:'unknown'}),e=>e.code==='INVALID_AI_PROVIDER');
  assert.throws(()=>aiSelection(openai,{baseUrl:'https://other.example'}),e=>e.code==='INVALID_AI_ENDPOINT');
});

test('Claude tool calls round-trip with grouped results and native content preserved',async()=>{
  const requests=[];
  const native=[{type:'thinking',thinking:'private reasoning',signature:'opaque-signature'},{type:'tool_use',id:'claude-call',name:'get_product',input:{product_id:102}}];
  await withFetch(async(url,options)=>{requests.push({url,headers:options.headers,body:JSON.parse(options.body)});return Response.json(requests.length===1?{content:native,stop_reason:'tool_use'}:{content:[{type:'text',text:'Canvas Bag costs INR 299.00.'}],stop_reason:'end_turn'});},async()=>{
    const adapter=createAIAdapter(config({AI_PROVIDER:'anthropic',ANTHROPIC_API_KEY:'claude-only',ANTHROPIC_MODEL:'account-claude'}));
    const first=await adapter.respond(initial,tools,'Store policy');const call=first.output.find(i=>i.type==='function_call');
    assert.equal(call.name,'get_product');assert.deepEqual(JSON.parse(call.arguments),{product_id:102});
    const second=await adapter.respond([...initial,...first.output,{type:'function_call_output',call_id:call.call_id,output:'{"price":"299.00"}'}],tools,'Store policy');
    assert.match(second.text,/299.00/);
    assert.equal(requests[0].url,'https://api.anthropic.com/v1/messages');assert.equal(requests[0].headers.Authorization,'Bearer claude-only');
    assert.deepEqual(requests[1].body.messages[1].content,native);
    assert.equal(requests[1].body.messages[2].content[0].tool_use_id,'claude-call');
    assert.equal(requests[0].body.tools[0].input_schema.additionalProperties,false);
    assert.equal(requests[0].body.system,'Store policy');assert.equal(requests[0].body.max_tokens,600);
  });
});
test('Gemini preserves thought signatures and links structured function responses',async()=>{
  const requests=[];const content={role:'model',parts:[{thought:true,text:'private',thoughtSignature:'sig-thought'},{functionCall:{id:'gemini-call',name:'get_product',args:{product_id:102}},thoughtSignature:'sig-function'}]};
  await withFetch(async(url,options)=>{requests.push({url,headers:options.headers,body:JSON.parse(options.body)});return Response.json({candidates:[{finishReason:'STOP',content:requests.length===1?content:{role:'model',parts:[{text:'Canvas Bag is available.'}]}}]});},async()=>{
    const adapter=createAIAdapter(config({AI_PROVIDER:'gemini',GEMINI_API_KEY:'gemini-only',GEMINI_MODEL:'models/account-gemini'}));
    const first=await adapter.respond(initial,tools,'Policy');const call=first.output.find(i=>i.type==='function_call');
    assert.equal(first.text,'');
    await adapter.respond([...initial,...first.output,{type:'function_call_output',call_id:call.call_id,output:'{"price":"299.00"}'}],tools,'Policy');
    assert.match(requests[0].url,/models\/account-gemini:generateContent$/);assert(!requests[0].url.includes('gemini-only'));
    assert.equal(requests[0].headers['x-goog-api-key'],'gemini-only');assert.deepEqual(requests[1].body.contents[1],content);
    const response=requests[1].body.contents[2].parts[0].functionResponse;assert.equal(response.id,'gemini-call');assert.deepEqual(response.response.result,{price:'299.00'});
    assert.equal(requests[0].body.tools[0].functionDeclarations[0].parametersJsonSchema.additionalProperties,false);
  });
});
test('compatible providers retain tool IDs and reasoning metadata while keeping their own endpoints and keys',async()=>{
  const requests=[];
  await withFetch(async(url,options)=>{const body=JSON.parse(options.body);requests.push({url,body,headers:options.headers});return Response.json({choices:[{finish_reason:requests.length===1?'tool_calls':'stop',message:requests.length===1?{role:'assistant',content:null,reasoning_content:'private',tool_calls:[{id:'chat-call',type:'function',function:{name:'get_product',arguments:'{"product_id":102}'}}]}:{role:'assistant',content:'Available.'}}]});},async()=>{
    const adapter=createAIAdapter(config({AI_PROVIDER:'deepseek',DEEPSEEK_API_KEY:'deepseek-only',DEEPSEEK_MODEL:'account-model',OPENAI_API_KEY:'must-not-use'}));
    const first=await adapter.respond(initial,tools,'Policy');
    await adapter.respond([...initial,...first.output,{type:'function_call_output',call_id:'chat-call',output:'{"available":true}'}],tools,'Policy');
    assert.equal(requests[0].url,'https://api.deepseek.com/chat/completions');assert.equal(requests[0].headers.Authorization,'Bearer deepseek-only');
    assert.equal(requests[1].body.messages[2].reasoning_content,'private');assert.equal(requests[1].body.messages[3].tool_call_id,'chat-call');
    assert.equal(requests[0].body.tools[0].function.name,'get_product');assert.equal(requests[0].body.max_tokens,600);
  });
});
test('Groq, OpenRouter, Ollama and custom services route through their configured chat endpoints',async()=>{
  const requests=[];
  await withFetch(async(url,options)=>{requests.push({url,headers:options.headers});return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:'Hello'}}]});},async()=>{
    for(const env of [{AI_PROVIDER:'groq',GROQ_API_KEY:'g',GROQ_MODEL:'m'},{AI_PROVIDER:'openrouter',OPENROUTER_API_KEY:'r',OPENROUTER_MODEL:'m'},{AI_PROVIDER:'ollama',OLLAMA_MODEL:'local-model'},{AI_PROVIDER:'compatible',AI_BASE_URL:'https://gateway.example/v1',AI_API_KEY:'custom',AI_MODEL:'m'}])await createAIAdapter(config(env)).respond(initial,tools,'Policy');
    assert.deepEqual(requests.map(r=>r.url),['https://api.groq.com/openai/v1/chat/completions','https://openrouter.ai/api/v1/chat/completions','http://127.0.0.1:11434/v1/chat/completions','https://gateway.example/v1/chat/completions']);
    assert.equal(requests[2].headers.Authorization,undefined);assert.equal(requests[3].headers.Authorization,'Bearer custom');
  });
});
test('model discovery handles provider schemas, pagination, deduplication, filtering, and secret headers',async()=>{
  const requests=[];
  await withFetch(async(url,options)=>{
    requests.push({url,headers:options.headers});
    if(String(url).includes('anthropic'))return Response.json(String(url).includes('after_id')?{data:[{id:'claude-b',display_name:'Claude B'}],has_more:false}:{data:[{id:'claude-a',display_name:'Claude A'}],has_more:true,last_id:'claude-a'});
    if(String(url).includes('googleapis'))return Response.json({models:[{name:'models/gemini-a',displayName:'Gemini A',supportedGenerationMethods:['generateContent']},{name:'models/embed',supportedGenerationMethods:['embedContent']}]});
    if(String(url).includes('openrouter'))return Response.json({data:[{id:'vendor/model',supported_parameters:['tools']},{id:'no-tools',supported_parameters:['temperature']}]});
    return Response.json({data:[{id:'local-a'},{id:'local-a'},{id:'disabled',active:false}]});
  },async()=>{
    const claude=await listModels(config({AI_PROVIDER:'anthropic',ANTHROPIC_API_KEY:'claude-secret'}));assert.deepEqual(claude.models.map(m=>m.id),['claude-a','claude-b']);assert.equal(claude.truncated,false);
    const gemini=await listModels(config({AI_PROVIDER:'gemini',GEMINI_API_KEY:'gemini-secret'}));assert.deepEqual(gemini.models.map(m=>m.id),['gemini-a']);
    const router=await listModels(config({AI_PROVIDER:'openrouter',OPENROUTER_API_KEY:'router-secret'}));assert.equal(router.models.length,1);assert.equal(router.models[0].toolSupport,'reported');
    const ollama=await listModels(config({AI_PROVIDER:'ollama'}));assert.deepEqual(ollama.models.map(m=>m.id),['local-a']);
    assert(!requests.some(r=>/secret/.test(r.url)));
  });
});
test('one agent turn pins its provider even if configuration changes during tool execution',async()=>{
  const app=await setup();app.config.mode='live';app.config.aiProvider='anthropic';app.config.anthropicKey='a';app.config.anthropicModel='claude-account';
  app.agent.ai=new AIClient(app.config);const endpoints=[];
  await withFetch(async(url)=>{endpoints.push(url);if(endpoints.length===1){app.config.aiProvider='gemini';app.config.geminiKey='g';app.config.geminiModel='gemini-account';return Response.json({content:[{type:'tool_use',id:'pin-call',name:'get_product',input:{product_id:102}}],stop_reason:'tool_use'});}return Response.json({content:[{type:'text',text:'Canvas Bag: INR 299.00'}],stop_reason:'end_turn'});},async()=>{
    await app.agent.run(wa,'pinned-provider','Canvas bag');assert.equal(endpoints.length,2);assert(endpoints.every(url=>url.includes('anthropic.com')));
    assert.equal((await app.store.transaction(tx=>tx.list('outbox'))).at(-1).message.text,'Canvas Bag: INR 299.00');
  });
});
test('truncated or malformed provider outputs never become tool executions',async()=>{
  await withFetch(async()=>Response.json({choices:[{finish_reason:'length',message:{content:'Partial',tool_calls:[]}}]}),async()=>{
    await assert.rejects(createAIAdapter(config({AI_PROVIDER:'ollama',OLLAMA_MODEL:'m'})).respond(initial,tools,'Policy'),e=>e.code==='PROVIDER_RESPONSE');
  });
});
