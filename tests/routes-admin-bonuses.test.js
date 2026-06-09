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

test('POST /api/admin/bonuses with min/max/days seeds current_points and ripens_from', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const r = await agent.post('/api/admin/bonuses').send({
    title: 'Wash car', points: 10, anti_cheat: 'honor',
    min_points: 3, max_points: 18, days_to_ripen: 5,
  });
  assert.equal(r.status, 200);
  const row = db.prepare("SELECT min_points, max_points, current_points, days_to_ripen, ripens_from FROM chores WHERE title='Wash car'").get();
  assert.equal(row.min_points, 3);
  assert.equal(row.max_points, 18);
  assert.equal(row.current_points, 3);
  assert.equal(row.days_to_ripen, 5);
  assert.ok(row.ripens_from);
});

test('POST /api/admin/bonuses rejects max_points < min_points', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const r = await agent.post('/api/admin/bonuses').send({
    title: 'Bad', points: 5, anti_cheat: 'honor',
    min_points: 20, max_points: 5,
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /max_points/);
});

test('POST /api/admin/bonuses rejects days_to_ripen out of 1..30', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const a = await agent.post('/api/admin/bonuses').send({ title: 'A', points: 1, min_points: 1, max_points: 2, days_to_ripen: 0 });
  assert.equal(a.status, 400);
  const b = await agent.post('/api/admin/bonuses').send({ title: 'B', points: 1, min_points: 1, max_points: 2, days_to_ripen: 31 });
  assert.equal(b.status, 400);
});

test('PATCH /api/admin/bonuses changing min_points resets current_points and ripens_full_on', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const created = (await agent.post('/api/admin/bonuses').send({
    title: 'Ramp', points: 10, anti_cheat: 'honor',
    min_points: 1, max_points: 10, days_to_ripen: 5,
  })).body.bonus;
  // Pretend the sweep ripened it part-way and stamped full-on.
  db.prepare("UPDATE chores SET current_points = 8, ripens_full_on = date('now','localtime') WHERE id = ?").run(created.id);
  const r = await agent.patch(`/api/admin/bonuses/${created.id}`).send({ min_points: 4, max_points: 12 });
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT current_points, ripens_full_on FROM chores WHERE id = ?').get(created.id);
  assert.equal(row.current_points, 4);
  assert.equal(row.ripens_full_on, null);
});

test('GET /api/admin/bonuses exposes ripening fields per bonus', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  await agent.post('/api/admin/bonuses').send({
    title: 'R', points: 5, anti_cheat: 'honor',
    min_points: 2, max_points: 15, days_to_ripen: 7,
  });
  const r = await agent.get('/api/admin/bonuses');
  assert.equal(r.status, 200);
  const b = r.body.bonuses.find(x => x.title === 'R');
  assert.equal(b.min_points, 2);
  assert.equal(b.max_points, 15);
  assert.equal(b.current_points, 2);
  assert.equal(b.days_to_ripen, 7);
});
