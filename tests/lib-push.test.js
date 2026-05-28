import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { isPushConfigured, saveSubscription, removeSubscription, sendToPerson } from '../src/lib/push.js';

function seedKid(db, name = 'K') {
  return db.prepare("INSERT INTO people (name, role) VALUES (?, 'kid') RETURNING id").get(name).id;
}
function fakeSub(endpoint = 'https://push.example/abc') {
  return { endpoint, keys: { p256dh: 'pkey', auth: 'akey' } };
}

test('isPushConfigured returns false without VAPID env', () => {
  assert.equal(isPushConfigured(), false);
});

test('saveSubscription inserts a subscription', () => {
  const db = freshDb();
  const kid = seedKid(db);
  saveSubscription(db, kid, fakeSub());
  const rows = db.prepare('SELECT * FROM push_subscriptions WHERE person_id = ?').all(kid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].endpoint, 'https://push.example/abc');
  assert.equal(rows[0].p256dh, 'pkey');
});

test('saveSubscription on same endpoint updates, no duplicate', () => {
  const db = freshDb();
  const kid = seedKid(db);
  saveSubscription(db, kid, fakeSub());
  saveSubscription(db, kid, { endpoint: 'https://push.example/abc', keys: { p256dh: 'pkey2', auth: 'akey2' } });
  const rows = db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').all('https://push.example/abc');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].p256dh, 'pkey2');
});

test('removeSubscription deletes by endpoint', () => {
  const db = freshDb();
  const kid = seedKid(db);
  saveSubscription(db, kid, fakeSub());
  removeSubscription(db, 'https://push.example/abc');
  const rows = db.prepare('SELECT * FROM push_subscriptions').all();
  assert.equal(rows.length, 0);
});

test('sendToPerson is a safe no-op when not configured', async () => {
  const db = freshDb();
  const kid = seedKid(db);
  saveSubscription(db, kid, fakeSub());
  await sendToPerson(db, kid, { title: 'T', body: 'B', tag: 'x' });
  assert.ok(true);
});
