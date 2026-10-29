import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, inject } from '../helpers.js';

test('admin login works on both local browser addresses and opens the protected workspace', async () => {
  const app = await setup();
  await app.operators.create('demo@example.test', 'demo-regression-password', 'admin');
  for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000']) {
    const login = await inject(app, '/api/operator/login', { method:'POST', headers:{origin}, data:{email:' DEMO@EXAMPLE.TEST ',password:'demo-regression-password'} });
    assert.equal(login.status,200,origin);
    const headers = {origin,cookie:login.headers['set-cookie'].split(';')[0],'x-csrf-token':login.body.csrf};
    for (const path of ['me','overview','system','settings']) assert.equal((await inject(app,`/api/operator/${path}`,{headers})).status,200,path);
    assert.equal((await inject(app,'/api/operator/settings',{method:'POST',headers,data:{revision:(await app.settings.read()).revision,values:{storeName:'Login checked'}}})).status,200);
  }
  assert.equal((await inject(app,'/api/operator/login',{method:'POST',headers:{origin:'http://attacker.example:3000'},data:{email:'demo@example.test',password:'demo-regression-password'}})).status,403);
});
test('login startup assets are served and the form never sends passwords in a GET URL', async () => {
  const app=await setup();
  const page=await inject(app,'/');
  assert.match(page.text, /id="login-form" method="post"/);
  assert.match(page.text, /id="startup-status"/);
  assert.match(page.text, /class="btn btn-primary login-submit" type="submit" disabled/);
  for (const path of ['/boot.js','/app.js','/pages.js','/ui.js','/simulator.js','/ai-settings.js']) {
    const response=await inject(app,path);
    assert.equal(response.status,200,path);assert.match(response.headers['content-type'],/javascript/);
  }
});
