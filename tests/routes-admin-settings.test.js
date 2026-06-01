import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';

async function asParent(app, db) {
  const id = db.prepare("INSERT INTO people (name, role) VALUES ('Mom','parent') RETURNING id").get().id;
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id, pin: '1234' });
  return agent;
}

test('GET /api/admin/settings returns all settings as a map', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.get('/api/admin/settings');
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.steal_unlock_time, '16:00');
});

test('PATCH /api/admin/settings/:key updates a single setting', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.patch('/api/admin/settings/steal_unlock_time').send({ value: '17:30' });
  assert.equal(res.status, 200);
  assert.equal(res.body.setting.value, '17:30');
  assert.equal(
    db.prepare("SELECT value FROM settings WHERE key='steal_unlock_time'").get().value,
    '17:30'
  );
});

test('PATCH rejects unknown keys (whitelist)', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.patch('/api/admin/settings/admin_pin_hash').send({ value: 'bad' });
  assert.equal(res.status, 400);
});

test('PATCH /api/admin/settings/streak_warning_time works (whitelisted)', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.patch('/api/admin/settings/streak_warning_time').send({ value: '19:30' });
  assert.equal(res.status, 200);
  assert.equal(res.body.setting.value, '19:30');
  const row = db.prepare("SELECT value FROM settings WHERE key='streak_warning_time'").get();
  assert.equal(row.value, '19:30');
});

test('settings endpoints reject non-parent', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: kid });
  const res = await agent.get('/api/admin/settings');
  assert.equal(res.status, 403);
});

test('PATCH /api/admin/settings/school_deadline_time succeeds (whitelisted)', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.patch('/api/admin/settings/school_deadline_time').send({ value: '17:30' });
  assert.equal(res.status, 200);
  const row = db.prepare("SELECT value FROM settings WHERE key = 'school_deadline_time'").get();
  assert.equal(row.value, '17:30');
});

test('PATCH /api/admin/settings/payout_day accepts a valid day name', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.patch('/api/admin/settings/payout_day').send({ value: 'friday' });
  assert.equal(res.status, 200);
  assert.equal(res.body.setting.value, 'friday');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='payout_day'").get().value, 'friday');
});

test('PATCH /api/admin/settings/payout_day rejects numeric strings (guards against legacy bug)', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.patch('/api/admin/settings/payout_day').send({ value: '0' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /day name/i);
});

test('PATCH /api/admin/settings/payout_day rejects garbage', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.patch('/api/admin/settings/payout_day').send({ value: 'whenever' });
  assert.equal(res.status, 400);
});
