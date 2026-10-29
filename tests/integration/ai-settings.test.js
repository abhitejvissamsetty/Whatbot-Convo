import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { generateKeyPairSync } from 'node:crypto';
import { setup, inject } from '../helpers.js';
import { config } from '../../src/config/env.js';
import { createAIAdapter, AnthropicMessages, GeminiContent } from '../../src/ai/adapters.js';

const actor={id:'test-admin',email:'owner@example.test',role:'admin'};
async function environment(run){const dir=await mkdtemp(join(tmpdir(),'convo-ai-'));const envPath=join(dir,'.env');await writeFile(envPath,'APP_MODE=mock\nOPENAI_API_KEY=original-openai\nOPENAI_MODEL=original-model\n',{mode:0o600});try{await run(await setup({envPath}),envPath,dir);}finally{await rm(dir,{recursive:true,force:true});}}
async function signIn(app,role='admin'){const email=role+'@example.test';await app.operators.create(email,'ai-settings-test-password',role);const result=await app.operators.login(email,'ai-settings-test-password');return {origin:app.config.publicUrl,cookie:`wa_session=${result.sessionToken}`,'x-csrf-token':result.csrf};}

test('provider/model changes persist per provider, preserve existing secrets, and expose saved versus active state',async()=>environment(async(app,path)=>{
  let state=await app.settings.deployment();
  const saved=await app.settings.saveDeployment({revision:state.revision,values:{AI_PROVIDER:'anthropic',ANTHROPIC_API_KEY:'claude-private-key',ANTHROPIC_MODEL:'account-claude'}},actor);
  assert.equal(saved.ai.savedProvider,'anthropic');assert.equal(saved.ai.activeProvider,'openai');assert(saved.restartRequired);
  const data=parseEnv(await readFile(path,'utf8'));assert.equal(data.OPENAI_API_KEY,'original-openai');assert.equal(data.ANTHROPIC_API_KEY,'claude-private-key');
  assert(!JSON.stringify(saved).includes('claude-private-key'));
  const restarted=config(data);assert.equal(restarted.aiProvider,'anthropic');assert(createAIAdapter(restarted) instanceof AnthropicMessages);
  state=await app.settings.deployment();
  await app.settings.saveDeployment({revision:state.revision,values:{AI_PROVIDER:'gemini',GEMINI_API_KEY:'gemini-private-key',GEMINI_MODEL:'account-gemini'}},actor);
  const next=parseEnv(await readFile(path,'utf8'));assert.equal(next.ANTHROPIC_API_KEY,'claude-private-key');assert.equal(next.OPENAI_MODEL,'original-model');assert(createAIAdapter(config(next)) instanceof GeminiContent);
  assert(!(await app.admin.auditList()).some(entry=>JSON.stringify(entry).includes('private-key')));
}));
test('incomplete provider selection and unsafe custom URLs cannot overwrite the environment',async()=>environment(async(app,path)=>{
  const state=await app.settings.deployment();const original=await readFile(path,'utf8');
  for(const values of [{AI_PROVIDER:'unknown'},{AI_PROVIDER:'anthropic',ANTHROPIC_MODEL:'m'},{AI_PROVIDER:'gemini',GEMINI_API_KEY:'k',GEMINI_MODEL:''},{AI_PROVIDER:'compatible',AI_BASE_URL:'http://remote.example/v1',AI_API_KEY:'k',AI_MODEL:'m'}])await assert.rejects(app.settings.saveDeployment({revision:state.revision,values},actor));
  assert.equal(await readFile(path,'utf8'),original);
  const result=await app.settings.saveDeployment({revision:state.revision,values:{AI_PROVIDER:'ollama',OLLAMA_BASE_URL:'http://localhost:11434/v1',OLLAMA_MODEL:'tool-capable-local-model'}},actor);
  assert.equal(result.ai.savedProvider,'ollama');assert.equal(parseEnv(await readFile(path,'utf8')).AI_PROVIDER,'ollama');
}));
test('model discovery is an explicit administrator read request with redacted credentials and CSRF',async()=>environment(async(app)=>{
  const admin=await signIn(app),operator=await signIn(app,'operator');
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async(url,options)=>{calls++;assert.equal(options.headers.Authorization,'Bearer entered-key');assert.equal(options.method,'GET');assert.equal(options.body,undefined);assert.equal(url,'https://api.anthropic.com/v1/models?limit=100');return Response.json({data:[{id:'account-claude',display_name:'Account Claude'}],has_more:false});};
  try{
    for(const headers of [{},operator,{...admin,'x-csrf-token':'wrong'}]){const response=await inject(app,'/api/operator/ai/models',{method:'POST',headers:{origin:app.config.publicUrl,...headers},data:{provider:'anthropic',apiKey:'entered-key'}});assert([401,403].includes(response.status));}
    assert.equal(calls,0);
    const response=await inject(app,'/api/operator/ai/models',{method:'POST',headers:admin,data:{provider:'anthropic',apiKey:'entered-key'}});
    assert.equal(response.status,200);assert.equal(response.body.models[0].id,'account-claude');assert.equal(calls,1);assert(!JSON.stringify(response.body).includes('entered-key'));
    assert(!(await app.admin.auditList()).some(e=>JSON.stringify(e).includes('entered-key')));
  }finally{globalThis.fetch=original;}
}));
test('selected AI integration completeness ignores unused provider credentials',async()=>environment(async(app)=>{
  const state=await app.settings.deployment();await app.settings.saveDeployment({revision:state.revision,values:{AI_PROVIDER:'gemini',GEMINI_API_KEY:'g',GEMINI_MODEL:'gemini-account'}},actor);
  const ai=(await app.admin.system()).integrations.find(i=>i.name==='ai');assert.equal(ai.configured,true);assert.equal(ai.requiredCount,3);assert.equal(ai.savedProvider,'gemini');assert.equal(ai.provider,'openai');
}));
test('live configuration accepts Claude without an OpenAI key and rejects missing selected credentials',async()=>environment(async(_app,_path,dir)=>{
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});const pem=join(dir,'flow.pem');await writeFile(pem,privateKey.export({format:'pem',type:'pkcs8'}));
  const env={APP_MODE:'live',STORE_DRIVER:'mysql',MYSQL_URL:'mysql://test:test@localhost/test',PUBLIC_URL:'https://assistant.example.test',WOO_URL:'https://store.example.test',META_APP_SECRET:'0123456789abcdef0123456789abcdef',META_VERIFY_TOKEN:'verify-0123456789abcdef0123456789abcdef',WOO_WEBHOOK_SECRET:'webhook-0123456789abcdef0123456789abcdef',META_GRAPH_VERSION:'v-test',META_TOKEN:'meta',META_PHONE_NUMBER_ID:'123',META_FLOW_ID:'456',FLOW_PRIVATE_KEY_PATH:pem,WOO_KEY:'woo',WOO_SECRET:'secret',WOO_BRIDGE_SECRET:'bridge-0123456789abcdef0123456789abcdef',AI_PROVIDER:'anthropic',ANTHROPIC_API_KEY:'claude',ANTHROPIC_MODEL:'claude-account'};
  const active=config(env);assert.equal(active.openaiKey,undefined);assert(createAIAdapter(active) instanceof AnthropicMessages);
  assert.throws(()=>config({...env,ANTHROPIC_API_KEY:''}),e=>e.code==='AI_KEY_REQUIRED');
}));
test('model discovery can reuse an active key when the environment file has a blank placeholder',async()=>environment(async(app,path)=>{
  await writeFile(path,'APP_MODE=mock\nOPENAI_API_KEY=\n');app.config.openaiKey='active-key';
  const draft=await app.settings.aiDraft({provider:'openai'});assert.equal(draft.selection.key,'active-key');
}));
