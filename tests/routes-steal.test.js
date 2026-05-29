import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';

function setUnlockMinutesAgo(db, minutes) {
  const d = new Date(Date.now() - minutes * 60 * 1000);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  db.prepare("UPDATE settings SET value = ? WHERE key = 'steal_unlock_time'").run(hhmm);
}
function setUnlockMinutesFromNow(db, minutes) {
  const d = new Date(Date.now() + minutes * 60 * 1000);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  db.prepare("UPDATE settings SET value = ? WHERE key = 'steal_unlock_time'").run(hhmm);
}
function seedKid(db, name) {
  return db.prepare("INSERT INTO people (name, role, weekly_target_pts) VALUES (?, 'kid', 100) RETURNING id").get(name).id;
}
function seedChore(db, title, weight = 3, isSchool = 0) {
  return db.prepare("INSERT INTO chores (title, weight, unstealable, recurs) VALUES (?, ?, ?, 'daily') RETURNING id").get(title, weight, isSchool).id;
}
function seedAssignment(db, choreId, kidId, status = 'pending') {
  return db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now', 'localtime'), ?) RETURNING id").get(choreId, kidId, status).id;
}
async function loginKid(app, id) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id });
  return agent;
}

test('POST /api/assignments/:id/steal succeeds after unlock time on stealable pending chore', async () => {
  const db = freshDb();
  setUnlockMinutesAgo(db, 60);
  const owner = seedKid(db, 'Owner');
  const stealer = seedKid(db, 'Stealer');
  const cId = seedChore(db, 'X', 3, 0);
  const aId = seedAssignment(db, cId, owner);

  const app = freshApp(db);
  const agent = await loginKid(app, stealer);
  const res = await agent.post(`/api/assignments/${aId}/steal`);
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT * FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.person_id, stealer);
  assert.equal(row.stolen_from, owner);
});

test('steal returns 400 before unlock time', async () => {
  const db = freshDb();
  setUnlockMinutesFromNow(db, 60);
  const owner = seedKid(db, 'Owner');
  const stealer = seedKid(db, 'Stealer');
  const cId = seedChore(db, 'X', 3, 0);
  const aId = seedAssignment(db, cId, owner);
  const app = freshApp(db);
  const agent = await loginKid(app, stealer);
  const res = await agent.post(`/api/assignments/${aId}/steal`);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not unlocked|too early|unlock/i);
});

test('steal returns 400 for unstealable chore', async () => {
  const db = freshDb();
  setUnlockMinutesAgo(db, 60);
  const owner = seedKid(db, 'Owner');
  const stealer = seedKid(db, 'Stealer');
  const cId = seedChore(db, 'Math', 3, 1);
  const aId = seedAssignment(db, cId, owner);
  const app = freshApp(db);
  const agent = await loginKid(app, stealer);
  const res = await agent.post(`/api/assignments/${aId}/steal`);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /cannot be stolen/i);
});

test('steal returns 400 if assignment is not pending', async () => {
  const db = freshDb();
  setUnlockMinutesAgo(db, 60);
  const owner = seedKid(db, 'Owner');
  const stealer = seedKid(db, 'Stealer');
  const cId = seedChore(db, 'X', 3, 0);
  const aId = seedAssignment(db, cId, owner, 'done');
  const app = freshApp(db);
  const agent = await loginKid(app, stealer);
  const res = await agent.post(`/api/assignments/${aId}/steal`);
  assert.equal(res.status, 400);
});

test('steal returns 403 if caller is the current owner', async () => {
  const db = freshDb();
  setUnlockMinutesAgo(db, 60);
  const owner = seedKid(db, 'Owner');
  const cId = seedChore(db, 'X', 3, 0);
  const aId = seedAssignment(db, cId, owner);
  const app = freshApp(db);
  const agent = await loginKid(app, owner);
  const res = await agent.post(`/api/assignments/${aId}/steal`);
  assert.equal(res.status, 403);
});

test('GET /api/home includes stealable list for siblings post-unlock', async () => {
  const db = freshDb();
  setUnlockMinutesAgo(db, 60);
  const owner = seedKid(db, 'Owner');
  const stealer = seedKid(db, 'Stealer');
  const cId = seedChore(db, 'X', 3, 0);
  seedAssignment(db, cId, owner);

  const app = freshApp(db);
  const agent = await loginKid(app, stealer);
  const res = await agent.get('/api/home');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.stealable));
  assert.equal(res.body.stealable.length, 1);
  assert.equal(res.body.stealable[0].title, 'X');
  assert.equal(res.body.stealable[0].owner_name, 'Owner');
});

test('GET /api/home returns empty stealable list before unlock', async () => {
  const db = freshDb();
  setUnlockMinutesFromNow(db, 60);
  const owner = seedKid(db, 'Owner');
  const stealer = seedKid(db, 'Stealer');
  const cId = seedChore(db, 'X', 3, 0);
  seedAssignment(db, cId, owner);
  const app = freshApp(db);
  const agent = await loginKid(app, stealer);
  const res = await agent.get('/api/home');
  assert.equal(res.body.stealable.length, 0);
});

test('GET /api/home stealable excludes school work', async () => {
  const db = freshDb();
  setUnlockMinutesAgo(db, 60);
  const owner = seedKid(db, 'Owner');
  const stealer = seedKid(db, 'Stealer');
  const cId = seedChore(db, 'Math', 3, 1);
  seedAssignment(db, cId, owner);
  const app = freshApp(db);
  const agent = await loginKid(app, stealer);
  const res = await agent.get('/api/home');
  assert.equal(res.body.stealable.length, 0);
});
