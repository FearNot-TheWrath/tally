import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';
import { today, toIso } from '../src/lib/dates.js';

function seedKid(db, name = 'K') {
  return db.prepare("INSERT INTO people (name, role, weekly_target_pts) VALUES (?, 'kid', 100) RETURNING id").get(name).id;
}
function seedChore(db) {
  return db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('T', 3, 'daily', '') RETURNING id").get().id;
}
function seedAssignment(db, choreId, kidId, dueDate, status = 'pending') {
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, ?)").run(choreId, kidId, dueDate, status);
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toIso(d);
}
async function loginKid(app, id) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id });
  return agent;
}

test('GET /api/home returns computed streak_days', async () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, daysAgo(1), 'done');
  seedAssignment(db, c, kid, today(), 'done');
  const agent = await loginKid(freshApp(db), kid);
  const res = await agent.get('/api/home');
  assert.equal(res.status, 200);
  assert.equal(res.body.person.streak_days, 2);
});

test('GET /api/home returns on_freeze true when in range', async () => {
  const db = freshDb();
  const kid = seedKid(db);
  db.prepare("UPDATE people SET freeze_start = ?, freeze_end = ? WHERE id = ?").run(today(), today(), kid);
  const agent = await loginKid(freshApp(db), kid);
  const res = await agent.get('/api/home');
  assert.equal(res.body.person.on_freeze, true);
});

test('GET /api/home returns streak_at_risk = false if streak is 0', async () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, today(), 'pending');
  const agent = await loginKid(freshApp(db), kid);
  const res = await agent.get('/api/home');
  assert.equal(res.body.person.streak_at_risk, false);
});

test('GET /api/home streak_at_risk respects streak_warning_time setting', async () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, daysAgo(1), 'done');
  seedAssignment(db, c, kid, today(), 'pending');
  const minAgo = new Date(Date.now() - 60_000);
  const hhmm = `${String(minAgo.getHours()).padStart(2,'0')}:${String(minAgo.getMinutes()).padStart(2,'0')}`;
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('streak_warning_time', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(hhmm);

  const agent = await loginKid(freshApp(db), kid);
  const res = await agent.get('/api/home');
  assert.equal(res.body.person.streak_days, 1);
  assert.equal(res.body.person.streak_at_risk, true);
});
