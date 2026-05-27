import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';

function seedKid(db, name) {
  return db.prepare("INSERT INTO people (name, role) VALUES (?, 'kid') RETURNING id").get(name).id;
}
function seedBonus(db, title = 'X', points = 10, antiCheat = 'honor') {
  return db.prepare(
    "INSERT INTO chores (title, points, kind, recurs, default_assignees, anti_cheat) VALUES (?, ?, 'bonus', 'none', '', ?) RETURNING id"
  ).get(title, points, antiCheat).id;
}
async function loginKid(app, id) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id });
  return agent;
}

test('POST /api/bonuses/:id/claim creates an assignment for the kid', async () => {
  const db = freshDb();
  const kid = seedKid(db, 'K');
  const bonusId = seedBonus(db, 'Mow', 30);
  const app = freshApp(db);
  const agent = await loginKid(app, kid);

  const res = await agent.post(`/api/bonuses/${bonusId}/claim`);
  assert.equal(res.status, 200);
  assert.ok(res.body.assignment_id);
  const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(res.body.assignment_id);
  assert.equal(a.chore_id, bonusId);
  assert.equal(a.person_id, kid);
  assert.equal(a.status, 'pending');
});

test('claim returns 409 if already claimed', async () => {
  const db = freshDb();
  const first = seedKid(db, 'First');
  const second = seedKid(db, 'Second');
  const bonusId = seedBonus(db);
  const app = freshApp(db);

  const firstAgent = await loginKid(app, first);
  await firstAgent.post(`/api/bonuses/${bonusId}/claim`);

  const secondAgent = await loginKid(app, second);
  const res = await secondAgent.post(`/api/bonuses/${bonusId}/claim`);
  assert.equal(res.status, 409);
});

test('claim returns 404 if bonus deleted', async () => {
  const db = freshDb();
  const kid = seedKid(db, 'K');
  const bonusId = seedBonus(db);
  db.prepare("UPDATE chores SET deleted_at = datetime('now') WHERE id = ?").run(bonusId);
  const app = freshApp(db);
  const agent = await loginKid(app, kid);
  const res = await agent.post(`/api/bonuses/${bonusId}/claim`);
  assert.equal(res.status, 404);
});

test('claim returns 404 if chore is not a bonus', async () => {
  const db = freshDb();
  const kid = seedKid(db, 'K');
  const cId = db.prepare("INSERT INTO chores (title, points, kind) VALUES ('Reg', 5, 'recurring') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await loginKid(app, kid);
  const res = await agent.post(`/api/bonuses/${cId}/claim`);
  assert.equal(res.status, 404);
});

test('claim rejects parents (only kids can claim)', async () => {
  const db = freshDb();
  const parentId = db.prepare("INSERT INTO people (name, role) VALUES ('Mom', 'parent') RETURNING id").get().id;
  const bonusId = seedBonus(db);
  const app = freshApp(db);
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: parentId, pin: '1234' });
  const res = await agent.post(`/api/bonuses/${bonusId}/claim`);
  assert.equal(res.status, 403);
});

test('GET /api/home includes unclaimed bonuses in bonuses[]', async () => {
  const db = freshDb();
  const kid = seedKid(db, 'K');
  seedBonus(db, 'Available', 15);
  const claimed = seedBonus(db, 'Already taken', 10);
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now', 'localtime'), 'pending')").run(claimed, kid);
  const app = freshApp(db);
  const agent = await loginKid(app, kid);
  const res = await agent.get('/api/home');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.bonuses));
  assert.equal(res.body.bonuses.length, 1);
  assert.equal(res.body.bonuses[0].title, 'Available');
});

test('GET /api/wall includes unclaimed bonuses', async () => {
  const db = freshDb();
  seedBonus(db, 'Up for grabs', 25);
  const app = freshApp(db);
  const res = await request(app).get('/api/wall');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.bonuses));
  assert.equal(res.body.bonuses.length, 1);
  assert.equal(res.body.bonuses[0].title, 'Up for grabs');
});
