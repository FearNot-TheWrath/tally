import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';
import { today } from '../src/lib/dates.js';

async function loginKid(app, id) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id });
  return agent;
}
function seedFrozenWithExcusedChore(db, ownerName = 'Owner', choreKind = 'recurring') {
  const owner = db.prepare("INSERT INTO people (name, role) VALUES (?, 'kid') RETURNING id").get(ownerName).id;
  const c = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees, kind) VALUES ('Walk dogs', 3, 'daily', '', ?) RETURNING id").get(choreKind).id;
  const aId = db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status, note) VALUES (?, ?, ?, 'excused', 'On freeze') RETURNING id").get(c, owner, today()).id;
  db.prepare("UPDATE people SET freeze_start = ?, freeze_end = ? WHERE id = ?").run(today(), today(), owner);
  return { owner, aId };
}

test('claim-cover transfers ownership cleanly', async () => {
  const db = freshDb();
  const { aId } = seedFrozenWithExcusedChore(db);
  const claimer = db.prepare("INSERT INTO people (name, role) VALUES ('Olivia','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await loginKid(app, claimer);

  const res = await agent.post(`/api/assignments/${aId}/claim-cover`);
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT * FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.person_id, claimer);
  assert.equal(row.status, 'pending');
  assert.equal(row.note, '');
  assert.equal(row.stolen_from, null);
});

test('claim-cover returns 404 if assignment does not exist', async () => {
  const db = freshDb();
  const claimer = db.prepare("INSERT INTO people (name, role) VALUES ('Olivia','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await loginKid(app, claimer);
  const res = await agent.post('/api/assignments/9999/claim-cover');
  assert.equal(res.status, 404);
});

test('claim-cover returns 409 if assignment is not excused', async () => {
  const db = freshDb();
  const owner = db.prepare("INSERT INTO people (name, role) VALUES ('Owner','kid') RETURNING id").get().id;
  const c = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('T', 3, 'daily', '') RETURNING id").get().id;
  const aId = db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, 'pending') RETURNING id").get(c, owner, today()).id;
  db.prepare("UPDATE people SET freeze_start = ?, freeze_end = ? WHERE id = ?").run(today(), today(), owner);
  const claimer = db.prepare("INSERT INTO people (name, role) VALUES ('Olivia','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await loginKid(app, claimer);
  const res = await agent.post(`/api/assignments/${aId}/claim-cover`);
  assert.equal(res.status, 409);
});

test('claim-cover returns 400 if owner is NOT on freeze', async () => {
  const db = freshDb();
  const owner = db.prepare("INSERT INTO people (name, role) VALUES ('Owner','kid') RETURNING id").get().id;
  const c = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('T', 3, 'daily', '') RETURNING id").get().id;
  const aId = db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, 'excused') RETURNING id").get(c, owner, today()).id;
  const claimer = db.prepare("INSERT INTO people (name, role) VALUES ('Olivia','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await loginKid(app, claimer);
  const res = await agent.post(`/api/assignments/${aId}/claim-cover`);
  assert.equal(res.status, 400);
});

test('claim-cover returns 403 if claimer tries to claim their own excused chore', async () => {
  const db = freshDb();
  const { owner, aId } = seedFrozenWithExcusedChore(db);
  const app = freshApp(db);
  const agent = await loginKid(app, owner);
  const res = await agent.post(`/api/assignments/${aId}/claim-cover`);
  assert.equal(res.status, 403);
});

test('claim-cover returns 400 for a bonus-kind chore', async () => {
  const db = freshDb();
  const { aId } = seedFrozenWithExcusedChore(db, 'Owner', 'bonus');
  const claimer = db.prepare("INSERT INTO people (name, role) VALUES ('Olivia','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await loginKid(app, claimer);
  const res = await agent.post(`/api/assignments/${aId}/claim-cover`);
  assert.equal(res.status, 400);
});

test('claim-cover second concurrent claim returns 409 (race-safe)', async () => {
  const db = freshDb();
  const { aId } = seedFrozenWithExcusedChore(db);
  const first = db.prepare("INSERT INTO people (name, role) VALUES ('First','kid') RETURNING id").get().id;
  const second = db.prepare("INSERT INTO people (name, role) VALUES ('Second','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const firstAgent = await loginKid(app, first);
  await firstAgent.post(`/api/assignments/${aId}/claim-cover`);
  const secondAgent = await loginKid(app, second);
  const res = await secondAgent.post(`/api/assignments/${aId}/claim-cover`);
  assert.equal(res.status, 409);
});

test('claim-cover rejects parents (kid-only)', async () => {
  const db = freshDb();
  const { aId } = seedFrozenWithExcusedChore(db);
  const parentId = db.prepare("INSERT INTO people (name, role) VALUES ('Mom','parent') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: parentId, pin: '1234' });
  const res = await agent.post(`/api/assignments/${aId}/claim-cover`);
  assert.equal(res.status, 403);
});
