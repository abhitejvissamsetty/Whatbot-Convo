import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { setup, inject, metaMessage, reviewed, placed, wa } from '../helpers.js';
import { Settings } from '../../src/services/settings.js';

const actor = { id: 'admin-id', email: 'admin@example.test', role: 'admin' };
async function signed(c, role='admin') {
  const email = `${role}@example.test`;
  await c.operators.create(email, 'a-strong-password-123', role);
  const response = await inject(c, '/api/operator/login', { method:'POST', data:{email,password:'a-strong-password-123'}, headers:{origin:c.config.publicUrl} });
  assert.equal(response.status,200);
  return {origin:c.config.publicUrl,cookie:response.headers['set-cookie'].split(';')[0],'x-csrf-token':response.body.csrf};
}

test('runtime settings round-trip with units and refresh across service instances', async () => {
  const c=await setup(); const initial=await c.settings.read();
  assert.equal(initial.values.flowTtl,30);
  const result=await c.settings.update({revision:0,values:{storeName:'Amigoo Shop',flowTtl:15,aiDailyLimit:12,assistantEnabled:false}},actor);
  assert.equal(result.values.storeName,'Amigoo Shop');assert.equal(result.values.flowTtl,15);assert.equal(c.config.flowTtl,900000);
  const otherConfig={...c.config,assistantEnabled:true,aiDailyLimit:50};
  const other=new Settings({config:otherConfig,store:c.store,now:c.now}); await other.refresh();
  assert.equal(otherConfig.assistantEnabled,false);assert.equal(otherConfig.aiDailyLimit,12);
  const conflicts=await Promise.allSettled([c.settings.update({revision:1,values:{aiDailyLimit:13}},actor),c.settings.update({revision:1,values:{aiDailyLimit:14}},actor)]);
  assert.equal(conflicts.filter(r=>r.status==='fulfilled').length,1);assert.equal(conflicts.find(r=>r.status==='rejected').reason.code,'SETTINGS_CONFLICT');
});
test('configuration rejects unknown fields, prototype keys, invalid limits and invalid templates',async()=>{
  const c=await setup();
  for(const values of [{aiMaxTools:99},{assistantEnabled:'false'},{retentionDays:0},{openaiKey:'leak'},JSON.parse('{"__proto__":{"x":true}}')])await assert.rejects(c.settings.update({revision:0,values},actor),e=>e.code==='INVALID_SETTINGS');
  await assert.rejects(c.settings.update({revision:0,values:{},templates:{payment_verified:{name:'not approved!',language:'en'}}},actor),e=>e.code==='INVALID_SETTINGS');
  assert.equal((await c.settings.read()).revision,0);
});
test('assistant pause stops automatic replies while preserving inbound history',async()=>{
  const c=await setup();await c.settings.update({revision:0,values:{assistantEnabled:false}},actor);
  await c.events.whatsapp(metaMessage(c,'Hi','paused'));await c.worker.tick(50);
  assert.equal(c.meta.sent.length,0);assert.equal((await c.store.transaction(tx=>tx.list('messages'))).length,1);
  await c.settings.update({revision:1,values:{assistantEnabled:true}},actor);
  await c.events.whatsapp(metaMessage(c,'Hi','resumed'));await c.worker.tick(50);assert.equal(c.meta.sent.length,1);
});
test('outbound pause holds durable deliveries and resume drains them',async()=>{
  const c=await setup();await c.settings.update({revision:0,values:{notificationsEnabled:false}},actor);
  await c.events.whatsapp(metaMessage(c));await c.worker.tick(50);assert.equal(c.meta.sent.length,0);
  assert((await c.store.transaction(tx=>tx.list('jobs'))).some(j=>j.type==='send'&&j.status==='pending'));
  await c.settings.update({revision:1,values:{notificationsEnabled:true}},actor);await c.worker.tick(50);assert.equal(c.meta.sent.length,1);
});
test('saved templates are actually used outside the customer service window',async()=>{
  const c=await setup();const p=await placed(c);await c.worker.tick(50);
  await c.settings.update({revision:0,values:{},templates:{payment_verified:{name:'approved_payment',language:'te'}}},actor);
  c.advance(25*3600000);await c.woo.markPaid(p.orderId);await c.orders.reconcile(p.orderId);await c.worker.tick(50);
  assert.equal(c.meta.sent.at(-1).message.type,'template');assert.equal(c.meta.sent.at(-1).message.name,'approved_payment');assert.equal(c.meta.sent.at(-1).message.language,'te');
});
test('deployment edits persist securely, preserve blank secrets, redact reads and require restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'convo-config-'));const path=join(dir,'.env');
  await writeFile(path,'APP_MODE=mock\nOPENAI_API_KEY=original-secret\nOPENAI_MODEL=old-model\n',{mode:0o600});
  try{
    const c=await setup({envPath:path});const initial=await c.settings.deployment();
    assert(!JSON.stringify(initial).includes('original-secret'));
    const result=await c.settings.saveDeployment({revision:initial.revision,values:{OPENAI_API_KEY:'',OPENAI_MODEL:'configured-model',WOO_URL:'https://stage.example.test'}},actor);
    assert.match(await readFile(path,'utf8'),/OPENAI_API_KEY=original-secret/);assert.match(await readFile(path,'utf8'),/OPENAI_MODEL='configured-model'/);
    assert.equal(result.restartRequired,true);assert.equal(c.config.model,undefined);assert.equal((await stat(path)).mode&0o777,0o600);
    await assert.rejects(c.settings.saveDeployment({revision:initial.revision,values:{OPENAI_MODEL:'other'}},actor),e=>e.code==='SETTINGS_CONFLICT');
    const current=await c.settings.deployment();
    for(const values of [{APP_MODE:'live'},{OPENAI_MODEL:'injection\nAPP_MODE=live'},{WOO_URL:'http://insecure.example'},{WOO_URL:'https://user:secret@example.test'}])await assert.rejects(c.settings.saveDeployment({revision:current.revision,values},actor),e=>e.code==='INVALID_SETTINGS');
    assert(!JSON.stringify(await c.admin.auditList()).includes('original-secret'));
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('new admin endpoints enforce authentication, roles, origin and CSRF',async()=>{
  const c=await setup();const operator=await signed(c,'operator');
  for(const path of ['settings','deployment','system','team','queue','audit'])assert.equal((await inject(c,`/api/operator/${path}`,{headers:operator})).status,403,path);
  for(const path of ['overview','orders','checkouts','catalog'])assert.equal((await inject(c,`/api/operator/${path}`,{headers:operator})).status,200,path);
  assert.equal((await inject(c,'/api/operator/settings')).status,401);
  const admin=await signed(c,'admin');
  assert.equal((await inject(c,'/api/operator/settings',{method:'POST',headers:{...admin,'x-csrf-token':'bad'},data:{revision:0,values:{assistantEnabled:false}}})).status,403);
  assert.equal((await inject(c,'/api/operator/settings',{method:'POST',headers:admin,data:{revision:0,values:{assistantEnabled:false}}})).status,200);
  assert.equal((await inject(c,'/api/mock/flows')).status,401);
  assert.equal((await inject(c,'/api/mock/flows',{headers:operator})).status,403);
});
test('overview and list endpoints report real totals without exposing checkout tokens or payment keys',async()=>{
  const c=await setup();const p=await placed(c);await c.woo.markPaid(p.orderId);await c.orders.reconcile(p.orderId);
  const result=await c.admin.overview();assert.equal(result.totals.orders,1);assert.equal(result.totals.paid,1);assert.equal(result.revenue.INR,349);
  assert.equal(result.chart.length,7);
  const orders=await c.admin.ordersList();assert(!JSON.stringify(orders).includes('paymentUrl'));
  const flows=await c.admin.flowsList();assert(!JSON.stringify(flows).includes(p.f.token));assert.equal(flows[0].items[0].name,'Canvas Bag');
});
test('checkout cancellation invalidates a session and never cancels an existing order',async()=>{
  const c=await setup();const r=await reviewed(c);await c.admin.cancelFlow(r.f.id,actor);
  await assert.rejects(c.checkout.transition(r.f.token,'REVIEW',r.confirmation,wa),e=>e.code==='EXPIRED_SESSION');assert.equal(c.woo.orders.size,0);
  const p=await placed(c);await assert.rejects(c.admin.cancelFlow(p.f.id,actor),e=>e.code==='ORDER_EXISTS');assert.equal(c.woo.orders.size,1);
});
test('manual order reconciliation schedules work and refreshes verified payment state',async()=>{
  const c=await setup();const p=await placed(c);await c.woo.markPaid(p.orderId);
  await c.admin.reconcile(p.orderId,actor,'first');await c.admin.reconcile(p.orderId,actor,'first');await c.worker.tick(50);
  assert.equal((await c.store.transaction(tx=>tx.get('orders',p.f.id))).paymentState,'PAID_VERIFIED');
  const jobs=await c.store.transaction(tx=>tx.list('jobs'));assert.equal(jobs.filter(j=>j.id.startsWith('manual:')).length,1);
});
test('disabling a team member revokes sessions and self-lockout is blocked',async()=>{
  const c=await setup();const admin=await c.operators.create('owner@example.test','owner-strong-password','admin');
  const member=await c.operators.create('member@example.test','member-strong-password','operator');
  const login=await c.operators.login(member.email,'member-strong-password');
  await c.admin.updateMember(member.id,{enabled:false},admin);
  await assert.rejects(c.operators.authenticate(login.sessionToken),e=>e.code==='UNAUTHORIZED');
  await assert.rejects(c.admin.updateMember(admin.id,{role:'operator'},admin),e=>e.code==='SELF_LOCKOUT');
  assert(!(await c.admin.team()).some(u=>'passwordHash' in u));
});
test('password change validates current password and revokes every existing session',async()=>{
  const c=await setup();const user=await c.operators.create('owner@example.test','original-long-password','admin');const login=await c.operators.login(user.email,'original-long-password');
  await assert.rejects(c.admin.changePassword(user,'wrong','new-long-password-123'),e=>e.code==='INVALID_PASSWORD');
  await c.admin.changePassword(user,'original-long-password','new-long-password-123');
  await assert.rejects(c.operators.authenticate(login.sessionToken),e=>e.code==='UNAUTHORIZED');
  assert((await c.operators.login(user.email,'new-long-password-123')).sessionToken);
});
test('uncertain delivery review is audited and cannot cause an automatic resend',async()=>{
  const c=await setup();let calls=0;c.meta.send=async()=>{calls++;throw new Error('timeout');};
  await c.events.whatsapp(metaMessage(c));await c.worker.tick(50);const o=(await c.store.transaction(tx=>tx.list('outbox')))[0];
  await c.admin.resolveDelivery(o.id,{resolution:'closed_without_resend',note:'Provider review completed by support.'},actor);
  await c.worker.send(o.id);assert.equal(calls,1);assert.equal((await c.admin.queue()).outbox[0].status,'resolved');assert((await c.admin.auditList()).some(a=>a.action==='delivery.reviewed'));
});
test('integration checks report mock status honestly and do not invoke external providers',async()=>{
  const c=await setup();const headers=await signed(c);const result=await inject(c,'/api/operator/integrations/openai/check',{method:'POST',headers,data:{}});
  assert.equal(result.status,200);assert.equal(result.body.status,'simulated');assert.match(result.body.message,/No external/);
  assert.equal((await c.admin.system()).integrations.find(i=>i.name==='ai').check.status,'simulated');
});
test('opaque deployment secrets preserve punctuation and spaces without dotenv injection',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'convo-secret-'));const path=join(dir,'.env');await writeFile(path,'APP_MODE=mock\n');
  try{
    const c=await setup({envPath:path});const current=await c.settings.deployment();const secret=' keep-$-#-"-back\\slash ';
    await c.settings.saveDeployment({revision:current.revision,values:{OPENAI_API_KEY:secret}},actor);
    assert.equal(parseEnv(await readFile(path,'utf8')).OPENAI_API_KEY,secret);
    assert(!JSON.stringify(await c.settings.deployment()).includes(secret));
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('read checks validate provider identity and are invalidated when active credentials change',async()=>{
  const c=await setup();const headers=await signed(c);c.config.mode='live';c.config.openaiKey='test-key';c.config.model='expected-model';
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async()=>Response.json({id:'different-model'});
    let response=await inject(c,'/api/operator/integrations/openai/check',{method:'POST',headers,data:{}});assert.equal(response.body.status,'failed');
    globalThis.fetch=async()=>Response.json({id:'expected-model'});
    response=await inject(c,'/api/operator/integrations/openai/check',{method:'POST',headers,data:{}});assert.equal(response.body.status,'read_access_verified');
    assert.equal((await c.admin.system()).integrations.find(i=>i.name==='ai').check.status,'read_access_verified');
    c.config.model='new-model';assert.equal((await c.admin.system()).integrations.find(i=>i.name==='ai').check,null);
  }finally{globalThis.fetch=original;}
});
test('workspace HTTP controls expose real data and enforce safe job retry targets',async()=>{
  const c=await setup();const headers=await signed(c);const p=await placed(c);
  const request=(path,data)=>inject(c,`/api/operator/${path}`,{method:data===undefined?'GET':'POST',headers,data});
  assert.equal((await request('overview')).body.totals.orders,1);
  assert.equal((await request('catalog')).body.length,2);
  assert.equal((await request('catalog/101/variations')).body[0].id,1001);
  assert.equal((await request(`orders/${p.orderId}/payment-link`,{requestId:'admin-link'})).status,200);
  assert.equal((await request('orders/all/reconcile',{requestId:'all-orders'})).body.queued,1);
  assert.equal((await request('retry',{kind:'invalid',id:'x'})).status,400);
  assert.equal((await request('maintenance',{})).status,200);
  const member=await request('team',{email:'new@example.test',password:'new-account-password',role:'operator'});assert.equal(member.status,200);
  assert.equal((await request(`team/${member.body.id}`,{enabled:false})).status,200);
  assert((await request('audit')).body.some(a=>a.action==='team.created'));
  for(const asset of ['/','/app.js','/pages.js','/simulator.js','/ui.js','/styles.css'])assert.equal((await inject(c,asset)).status,200,asset);
});
