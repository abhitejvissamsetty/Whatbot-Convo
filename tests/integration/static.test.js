import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setup, inject } from '../helpers.js';
import { createHandler } from '../../src/http/app.js';

test('frontend modules return source and correct MIME for GET and HEAD', async () => {
  const app=await setup();
  for(const name of ['boot','app','ui','pages','simulator','ai-settings']) {
    const response=await inject(app,`/${name}.js`);
    assert.equal(response.status,200,name);
    assert.match(response.headers['content-type'],/^application\/javascript/);
    assert.equal(response.headers['x-content-type-options'],'nosniff');
    assert(!response.text.startsWith('{"error"'));
    const head=await inject(app,`/${name}.js`,{method:'HEAD'});
    assert.equal(head.status,200);assert.match(head.headers['content-type'],/^application\/javascript/);assert.equal(head.text,'');
  }
});
test('new frontend modules do not require editing backend routes',async()=>{
  const app=await setup();const name=`asset-test-${randomUUID()}.js`;const url=new URL(`../../public/${name}`,import.meta.url);
  await writeFile(url,'export const frontendAsset = true;\n',{flag:'wx'});
  try{const response=await inject(app,`/${name}`);assert.equal(response.status,200);assert.match(response.text,/export const frontendAsset/);assert.match(response.headers['content-type'],/javascript/);}
  finally{await unlink(url);}
  const missing=await inject(app,`/${name}`);assert.equal(missing.status,404);assert.match(missing.headers['content-type'],/^text\/plain/);
  for(const path of ['/.env','/src/server.js','/package.json'])assert.equal((await inject(app,path)).status,404,path);
});
test('API rate limiting cannot prevent the sign-in scripts from loading',async()=>{
  const app=await setup();const handler=createHandler(app);
  let last;
  for(let i=0;i<601;i++)last=await inject(app,'/api/unknown',{handler});
  assert.equal(last.status,429);
  const script=await inject(app,'/boot.js',{handler});assert.equal(script.status,200);assert.match(script.headers['content-type'],/javascript/);
});
