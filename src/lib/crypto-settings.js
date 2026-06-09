import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

// AES-256-GCM. 12-byte nonce, 16-byte auth tag, ciphertext.
// Stored payload (base64): [12-byte nonce][16-byte tag][ciphertext]
//
// Key derivation: scrypt(secret, fixed salt, 32 bytes). The salt is the literal
// string 'tally-wall-calendar-v1' so the same SECRET always derives the same key.

const SALT = Buffer.from('tally-wall-calendar-v1');
const KEY_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;

function deriveKey(secret) {
  return scryptSync(String(secret), SALT, KEY_LEN);
}

export function encryptForSetting(plaintext, secret) {
  const key = deriveKey(secret);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, enc]).toString('base64');
}

export function decryptFromSetting(ciphertext, secret) {
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) return null;
  let buf;
  try { buf = Buffer.from(ciphertext, 'base64'); } catch { return null; }
  if (buf.length < NONCE_LEN + TAG_LEN + 1) return null;
  const nonce = buf.subarray(0, NONCE_LEN);
  const tag   = buf.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN);
  const enc   = buf.subarray(NONCE_LEN + TAG_LEN);
  try {
    const key = deriveKey(secret);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return null;
  }
}
