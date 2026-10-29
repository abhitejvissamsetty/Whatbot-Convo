import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, publicEncrypt, constants, createCipheriv, createDecipheriv } from 'node:crypto';
import { signature, verifyMeta, verifyWoo, hashPassword, checkPassword, normalizeWa } from '../../src/security/core.js';
import { decryptFlow, encryptFlow } from '../../src/security/flowCrypto.js';
import { config } from '../../src/config/env.js';

test('signatures cover original bytes and reject missing, modified, or malformed values', () => {
  const raw = Buffer.from('{ "id": 1 }');
  assert(verifyMeta(raw, `sha256=${signature(raw, 'secret')}`, 'secret'));
  assert(verifyWoo(raw, signature(raw, 'secret', 'base64'), 'secret'));
  assert(!verifyMeta(Buffer.from('{"id":1}'), `sha256=${signature(raw, 'secret')}`, 'secret'));
  assert(!verifyWoo(raw, undefined, 'secret'));
  assert(!verifyMeta(raw, 'sha256=wrong', 'secret'));
});
test('password hashes use independent salts and reject wrong passwords', () => {
  const a = hashPassword('a-long-password-123');
  assert.notEqual(a, hashPassword('a-long-password-123'));
  assert(checkPassword('a-long-password-123', a));
  assert(!checkPassword('wrong', a));
  assert.throws(() => hashPassword('short'));
});
test('phone normalization and configuration fail closed', () => {
  assert.equal(normalizeWa('+919876543210'), '919876543210');
  assert.throws(() => normalizeWa('123'));
  assert.throws(() => config({ APP_MODE: 'live' }), /required|Missing/);
  assert.throws(() => config({ APP_MODE: 'mock', HOST: '0.0.0.0' }), /loopback/);
  assert.throws(() => config({ APP_MODE: 'mock', NODE_ENV: 'production' }), /Production/);
});
test('Meta Flow RSA/AES roundtrip, flipped response IV, and tamper rejection', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const key = randomBytes(16), iv = randomBytes(16);
  const cipher = createCipheriv('aes-128-gcm', key, iv);
  const data = { action: 'ping', version: '3.0' };
  const body = {
    encrypted_aes_key: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key).toString('base64'),
    initial_vector: iv.toString('base64'),
    encrypted_flow_data: Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final(), cipher.getAuthTag()]).toString('base64'),
  };
  const decoded = decryptFlow(body, pem);
  assert.deepEqual(decoded.data, data);
  const response = Buffer.from(encryptFlow({ data: { status: 'active' } }, decoded.key, decoded.iv), 'base64');
  const decipher = createDecipheriv('aes-128-gcm', key, Buffer.from(iv.map(b => b ^ 255)));
  decipher.setAuthTag(response.subarray(-16));
  assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(response.subarray(0, -16)), decipher.final()])), { data: { status: 'active' } });
  const tampered = Buffer.from(body.encrypted_flow_data, 'base64'); tampered[0] ^= 1;
  assert.throws(() => decryptFlow({ ...body, encrypted_flow_data: tampered.toString('base64') }, pem), /Invalid encrypted/);
  assert.throws(() => decryptFlow({ ...body, encrypted_aes_key: 'bad' }, pem), e => e.status === 421);
});
