import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptForSetting, decryptFromSetting } from '../src/lib/crypto-settings.js';

const SECRET = 'a-very-long-test-secret-1234567890abcdef';

test('encryptForSetting + decryptFromSetting roundtrip', () => {
  const plain = 'refresh-token-1//abc123';
  const ct = encryptForSetting(plain, SECRET);
  assert.ok(typeof ct === 'string' && ct.length > 0);
  assert.notEqual(ct, plain);
  const round = decryptFromSetting(ct, SECRET);
  assert.equal(round, plain);
});

test('decryptFromSetting with the wrong secret returns null', () => {
  const ct = encryptForSetting('payload', SECRET);
  assert.equal(decryptFromSetting(ct, 'different-secret-xxxxxxxxxxxxxxxxxxxxxx'), null);
});

test('decryptFromSetting on tampered ciphertext returns null', () => {
  const ct = encryptForSetting('payload', SECRET);
  // Flip a byte in the middle.
  const buf = Buffer.from(ct, 'base64');
  buf[buf.length - 5] ^= 0xff;
  const tampered = buf.toString('base64');
  assert.equal(decryptFromSetting(tampered, SECRET), null);
});

test('decryptFromSetting on empty / garbage input returns null', () => {
  assert.equal(decryptFromSetting('', SECRET), null);
  assert.equal(decryptFromSetting('not-base64-!@#$', SECRET), null);
  assert.equal(decryptFromSetting('AAA=', SECRET), null);
});

test('encryptForSetting produces different ciphertext for the same plaintext (random nonce)', () => {
  const a = encryptForSetting('x', SECRET);
  const b = encryptForSetting('x', SECRET);
  assert.notEqual(a, b);
});
