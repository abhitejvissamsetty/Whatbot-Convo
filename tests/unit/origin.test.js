import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedOrigin } from '../../src/security/origin.js';

test('local demo accepts only equivalent loopback origins on its configured port', () => {
  const config = {mode:'mock',production:false,publicUrl:'http://localhost:3000'};
  for (const origin of ['http://localhost:3000','http://127.0.0.1:3000','http://[::1]:3000']) assert(allowedOrigin(origin,config),origin);
  for (const origin of [undefined,'null','http://attacker.test:3000','http://localhost.attacker.test:3000','http://127.0.0.1:4000','https://localhost:3000','http://localhost:3000/path','http://user:password@localhost:3000']) assert(!allowedOrigin(origin,config),String(origin));
});
test('live and production origin checks stay exact', () => {
  const live = {mode:'live',production:false,publicUrl:'https://store.example.test'};
  assert(allowedOrigin('https://store.example.test',live));
  for (const origin of ['https://other.example.test','http://localhost:3000','http://127.0.0.1:3000']) assert(!allowedOrigin(origin,live));
  assert(!allowedOrigin('http://127.0.0.1:3000',{mode:'mock',production:true,publicUrl:'http://localhost:3000'}));
});
