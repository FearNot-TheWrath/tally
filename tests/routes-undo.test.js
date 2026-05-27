import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';

function seedDoneHonor(db, kidId) {
  const c = db.prepare(`
    INSERT INTO chores (title, points, recurs, default_assignees, anti_cheat)
    VALUES ('Bed', 5, 'daily', ?, 'honor') RETURNING id
  `).get(String(kidId)).id;
  return db.prepare(`
    INSERT INTO assignments (chore_id, person_id, due_date, status, points_earned)
    VALUES (?, ?, date('now', 'localtime'), 'done', 5) RETURNING id
  `).get(c, kidId).id;
}

function seedSubmittedPhoto(db, kidId) {
  const c = db.prepare(`
    INSERT INTO chores (title, points, recurs, default_assignees, anti_cheat)
    VALUES ('Vacuum', 10, 'daily', ?, 'photo') RETURNING id
  `).get(String(kidId)).id;
  return db.prepare(`
    INSERT INTO assignments (chore_id, person_id, due_date, status, photo_path)
    VALUES (?, ?, date('now', 'localtime'), 'submitted', '/fake/path.jpg') RETURNING id
  `).get(c, kidId).id;
}

async function loginKid(app, id) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id });
  return agent;
}

test('POST /api/assignments/:id/undo on a done honor chore reverts to pending', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const aId = seedDoneHonor(db, kid);
  const app = freshApp(db);
  const agent = await loginKid(app, kid);

  const res = await agent.post(`/api/assignments/${aId}/undo`);
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT * FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'pending');
  assert.equal(row.points_earned, 0);
});

test('undo rejects non-honor chores', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const aId = seedSubmittedPhoto(db, kid);
  const app = freshApp(db);
  const agent = await loginKid(app, kid);

  const res = await agent.post(`/api/assignments/${aId}/undo`);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /honor/i);
});

test('undo rejects a pending honor chore (nothing to undo)', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const c = db.prepare("INSERT INTO chores (title, points, default_assignees, anti_cheat) VALUES ('X',5,?,'honor') RETURNING id").get(String(kid)).id;
  const aId = db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?,?,date('now', 'localtime'),'pending') RETURNING id").get(c, kid).id;
  const app = freshApp(db);
  const agent = await loginKid(app, kid);

  const res = await agent.post(`/api/assignments/${aId}/undo`);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not done/i);
});

test('undo blocks another kid from reverting your chore', async () => {
  const db = freshDb();
  const a = db.prepare("INSERT INTO people (name, role) VALUES ('A','kid') RETURNING id").get().id;
  const b = db.prepare("INSERT INTO people (name, role) VALUES ('B','kid') RETURNING id").get().id;
  const aId = seedDoneHonor(db, a);
  const app = freshApp(db);
  const agent = await loginKid(app, b);

  const res = await agent.post(`/api/assignments/${aId}/undo`);
  assert.equal(res.status, 403);
});
