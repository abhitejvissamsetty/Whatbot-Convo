import { createPrivateKey, privateDecrypt, constants, createDecipheriv, createCipheriv } from 'node:crypto';
import { AppError } from './core.js';

export function decryptFlow(body, pem, passphrase) {
  let key;
  try {
    key = privateDecrypt({ key: createPrivateKey({ key: pem, passphrase }), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(body.encrypted_aes_key, 'base64'));
  } catch { throw new AppError('FLOW_KEY', 'Unable to decrypt request', 421); }
  try {
    const iv = Buffer.from(body.initial_vector, 'base64');
    const encrypted = Buffer.from(body.encrypted_flow_data, 'base64');
    if (key.length !== 16 || iv.length !== 16 || encrypted.length < 17) throw new Error('Invalid envelope');
    const decipher = createDecipheriv('aes-128-gcm', key, iv);
    decipher.setAuthTag(encrypted.subarray(-16));
    const data = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString('utf8'));
    return { data, key, iv };
  } catch { throw new AppError('FLOW_DATA', 'Invalid encrypted payload', 400); }
}
export function encryptFlow(data, key, iv) {
  const flipped = Buffer.from(iv.map(byte => byte ^ 255));
  const cipher = createCipheriv('aes-128-gcm', key, flipped);
  return Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final(), cipher.getAuthTag()]).toString('base64');
}
