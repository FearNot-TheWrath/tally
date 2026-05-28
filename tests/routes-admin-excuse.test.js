import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';
import { today } from '../src/lib/dates.js';

async function asParent(app, db) {
  const id = db.prepare("INSERT INTO people (name, role) VALUES ('Mom','parent') RETURNING id").get().id;
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id, pin: '1234' });
  return agent;
}
function seedAssignment(db, kind = 'recurring') {
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const c = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees, kind) VALUES ('T',3,'daily','',?) RETURNING id").get(kind).id;
  return db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, 'pending') RETURNING id").get(c, kid, today()).id;
}

test('POST excuse sets status excused and stores note', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const aId = seedAssignment(db);
  const agent = await asParent(app, db);
  const res = await agent.post(`/api/admin/assignments/${aId}/excuse`).send({ note: 'Dog hurt leg' });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT status, note FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'excused');
  assert.equal(row.note, 'Dog hurt leg');
});

test('POST excuse with blank note defaults to Excused by parent', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const aId = seedAssignment(db);
  const agent = await asParent(app, db);
  const res = await agent.post(`/api/admin/assignments/${aId}/excuse`).send({ note: '' });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT note FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.note, 'Excused by parent');
});

test('POST excuse rejects bonus-chore assignments', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const aId = seedAssignment(db, 'bonus');
  const agent = await asParent(app, db);
  const res = await agent.post(`/api/admin/assignments/${aId}/excuse`).send({ note: 'x' });
  assert.equal(res.status, 400);
});

test('POST unexcuse reverts to pending and clears note', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const aId = seedAssignment(db);
  const agent = await asParent(app, db);
  await agent.post(`/api/admin/assignments/${aId}/excuse`).send({ note: 'x' });
  const res = await agent.post(`/api/admin/assignments/${aId}/unexcuse`).send({});
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT status, note FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'pending');
  assert.equal(row.note, '');
});

test('POST unexcuse on a non-excused assignment returns 409', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const aId = seedAssignment(db);
  const agent = await asParent(app, db);
  const res = await agent.post(`/api/admin/assignments/${aId}/unexcuse`).send({});
  assert.equal(res.status, 409);
});

test('excuse endpoints reject non-parent', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const aId = seedAssignment(db);
  const res = await request(app).post(`/api/admin/assignments/${aId}/excuse`).send({ note: 'x' });
  assert.equal(res.status, 401);
});
