import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const KEYLEN = 64;

export function hashPin(pin) {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, KEYLEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPin(pin, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(pin, salt, KEYLEN);
  return timingSafeEqual(expected, actual);
}
