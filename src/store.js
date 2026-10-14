import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { profileInput, assert } from './validation.js';

export function encryptionKey(value) {
  assert(typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value), 'DATA_ENCRYPTION_KEY must be 64 hex characters', 500);
  return Buffer.from(value, 'hex');
}
export function encrypt(value, key) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);
  return {version:1, iv:iv.toString('base64'), tag:cipher.getAuthTag().toString('base64'), ciphertext:body.toString('base64')};
}
export function decrypt(wrapped, key) {
  assert(wrapped?.version === 1, 'Unsupported encrypted datastore version', 500);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(wrapped.iv,'base64'));
  decipher.setAuthTag(Buffer.from(wrapped.tag,'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(wrapped.ciphertext,'base64')),decipher.final()]).toString('utf8'));
}
export function createStore({file, key}) {
  const filepath = resolve(file);
  const initial = () => ({schema:1, profile:profileInput({}), travelers:{}, payment_tokens:{}, accounts:{}, watches:{}, cache:{}, quotes:{}, bookings:{}, awards:{}});
  let state = existsSync(filepath) ? decrypt(JSON.parse(readFileSync(filepath,'utf8')),key) : initial();
  assert(state.schema === 1, 'Unsupported database schema', 500);
  function persist() {
    mkdirSync(dirname(filepath), {recursive:true, mode:0o700});
    const tmp = `${filepath}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(encrypt(state,key)), {flag:'wx', mode:0o600});
    chmodSync(tmp,0o600); renameSync(tmp,filepath);
  }
  return {
    get() { return structuredClone(state); },
    mutate(fn) { const next=structuredClone(state); const output=fn(next); state=next; persist(); return output; }
  };
}
