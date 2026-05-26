import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';
import { generateForToday } from '../src/lib/assignments.js';
import { today } from '../src/lib/dates.js';

function setup() {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role, weekly_target_pts) VALUES ('Gabriel','kid',150) RETURNING id").get().id;
  const choreId = db.prepare(`
    INSERT INTO chores (title, points, recurs, default_assignees, anti_cheat)
    VALUES ('Make bed', 5, 'daily', ?, 'honor') RETURNING id
  `).get(String(kid)).id;
  generateForToday(db);
  return { db, kid, choreId, app: freshApp(db) };
}

async function loginAs(app, personId) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: personId });
  return agent;
}

test('GET /api/home returns today\'s + overdue assignments for the kid', async () => {
  const { app, kid } = setup();
  const agent = await loginAs(app, kid);
  const res = await agent.get('/api/home');
  assert.equal(res.status, 200);
  assert.equal(res.body.person.name, 'Gabriel');
  assert.equal(res.body.today.length, 1);
  assert.equal(res.body.today[0].title, 'Make bed');
  assert.equal(res.body.today[0].status, 'pending');
});

test('POST /api/assignments/:id/done flips status to done', async () => {
  const { app, kid, db } = setup();
  const agent = await loginAs(app, kid);
  const a = db.prepare("SELECT id FROM assignments WHERE person_id = ?").get(kid);
  const res = await agent.post(`/api/assignments/${a.id}/done`);
  assert.equal(res.status, 200);
  const after = db.prepare('SELECT status FROM assignments WHERE id = ?').get(a.id);
  assert.equal(after.status, 'done');
});

test('cannot mark someone else\'s assignment done', async () => {
  const { app, db } = setup();
  const other = db.prepare("INSERT INTO people (name, role) VALUES ('Olivia','kid') RETURNING id").get().id;
  const agent = await loginAs(app, other);
  const a = db.prepare("SELECT id FROM assignments").get();
  const res = await agent.post(`/api/assignments/${a.id}/done`);
  assert.equal(res.status, 403);
});

test('GET /api/home rejects unauthenticated requests', async () => {
  const { app } = setup();
  const res = await request(app).get('/api/home');
  assert.equal(res.status, 401);
});
