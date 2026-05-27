import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';

async function asParent(app, db) {
  const id = db.prepare("INSERT INTO people (name, role) VALUES ('Mom','parent') RETURNING id").get().id;
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id, pin: '1234' });
  return { agent, id };
}

async function asKid(app, db, name = 'K') {
  const id = db.prepare("INSERT INTO people (name, role) VALUES (?, 'kid') RETURNING id").get(name).id;
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id });
  return { agent, id };
}

test('POST /api/admin/bonuses creates a bonus chore with kind=bonus and forced defaults', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const res = await agent.post('/api/admin/bonuses').send({
    title: 'Mow lawn',
    points: 30,
    anti_cheat: 'photo',
    description: 'Mow the whole front and back',
    photo_prompt: 'Show me a picture of the mowed lawn',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.bonus.title, 'Mow lawn');
  assert.equal(res.body.bonus.points, 30);
  assert.equal(res.body.bonus.kind, 'bonus');
  assert.equal(res.body.bonus.recurs, 'none');
  assert.equal(res.body.bonus.default_assignees, '');
  assert.equal(res.body.bonus.anti_cheat, 'photo');
});

test('POST /api/admin/bonuses ignores client-sent kind/recurs/default_assignees', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const res = await agent.post('/api/admin/bonuses').send({
    title: 'Sneaky',
    points: 10,
    kind: 'recurring',
    recurs: 'daily',
    default_assignees: '1,2,3',
  });
  assert.equal(res.body.bonus.kind, 'bonus');
  assert.equal(res.body.bonus.recurs, 'none');
  assert.equal(res.body.bonus.default_assignees, '');
});

test('POST /api/admin/bonuses requires title and points', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const r1 = await agent.post('/api/admin/bonuses').send({ points: 10 });
  assert.equal(r1.status, 400);
  const r2 = await agent.post('/api/admin/bonuses').send({ title: 'X' });
  assert.equal(r2.status, 400);
});

test('GET /api/admin/bonuses lists active and claimed bonuses with status', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const { id: kidId } = await asKid(app, db, 'K1');

  const post = await agent.post('/api/admin/bonuses').send({ title: 'Unclaimed', points: 5 });
  const unclaimedId = post.body.bonus.id;

  const claimedId = db.prepare("INSERT INTO chores (title, points, kind, recurs, default_assignees) VALUES ('Claimed', 20, 'bonus', 'none', '') RETURNING id").get().id;
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now', 'localtime'), 'pending')").run(claimedId, kidId);

  const res = await agent.get('/api/admin/bonuses');
  assert.equal(res.status, 200);
  assert.equal(res.body.bonuses.length, 2);

  const unc = res.body.bonuses.find(b => b.id === unclaimedId);
  assert.equal(unc.claimed_by, null);

  const cl = res.body.bonuses.find(b => b.id === claimedId);
  assert.equal(cl.claimed_by, kidId);
  assert.equal(cl.claimed_by_name, 'K1');
  assert.equal(cl.assignment_status, 'pending');
});

test('PATCH /api/admin/bonuses/:id updates an unclaimed bonus', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const post = await agent.post('/api/admin/bonuses').send({ title: 'X', points: 5 });
  const id = post.body.bonus.id;
  const r = await agent.patch(`/api/admin/bonuses/${id}`).send({ title: 'Y', points: 25 });
  assert.equal(r.status, 200);
  assert.equal(r.body.bonus.title, 'Y');
  assert.equal(r.body.bonus.points, 25);
});

test('PATCH on a claimed bonus returns 409', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const { id: kidId } = await asKid(app, db);
  const post = await agent.post('/api/admin/bonuses').send({ title: 'X', points: 5 });
  const id = post.body.bonus.id;
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now', 'localtime'), 'pending')").run(id, kidId);

  const r = await agent.patch(`/api/admin/bonuses/${id}`).send({ title: 'Y' });
  assert.equal(r.status, 409);
});

test('DELETE /api/admin/bonuses/:id soft-deletes the bonus chore', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const post = await agent.post('/api/admin/bonuses').send({ title: 'X', points: 5 });
  const id = post.body.bonus.id;

  const r = await agent.delete(`/api/admin/bonuses/${id}`);
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT deleted_at FROM chores WHERE id = ?').get(id);
  assert.ok(row.deleted_at);
});

test('admin bonuses endpoints reject non-parent', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const { agent: kidAgent } = await asKid(app, db);
  const r1 = await kidAgent.get('/api/admin/bonuses');
  assert.equal(r1.status, 403);
  const r2 = await kidAgent.post('/api/admin/bonuses').send({ title: 'X', points: 5 });
  assert.equal(r2.status, 403);
});
