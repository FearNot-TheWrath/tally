import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';

async function loginKid(app, db) {
  const id = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id });
  return { agent, id };
}

test('GET /api/push/vapid-key returns 503 when not configured', async () => {
  const db = freshDb();
  const { agent } = await loginKid(freshApp(db), db);
  const res = await agent.get('/api/push/vapid-key');
  assert.equal(res.status, 503);
});

test('POST /api/push/subscribe saves a subscription', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const { agent, id } = await loginKid(app, db);
  const sub = { endpoint: 'https://push.example/xyz', keys: { p256dh: 'p', auth: 'a' } };
  const res = await agent.post('/api/push/subscribe').send(sub);
  assert.equal(res.status, 200);
  const rows = db.prepare('SELECT * FROM push_subscriptions WHERE person_id = ?').all(id);
  assert.equal(rows.length, 1);
});

test('POST /api/push/unsubscribe removes a subscription', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const { agent, id } = await loginKid(app, db);
  const sub = { endpoint: 'https://push.example/xyz', keys: { p256dh: 'p', auth: 'a' } };
  await agent.post('/api/push/subscribe').send(sub);
  const res = await agent.post('/api/push/unsubscribe').send({ endpoint: 'https://push.example/xyz' });
  assert.equal(res.status, 200);
  const rows = db.prepare('SELECT * FROM push_subscriptions').all();
  assert.equal(rows.length, 0);
});

test('push endpoints reject non-kid', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const res = await request(app).post('/api/push/subscribe').send({ endpoint: 'x', keys: {} });
  assert.equal(res.status, 401);
});
