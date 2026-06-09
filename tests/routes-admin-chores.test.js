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

test('admin chores: full CRUD', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const agent = await asParent(app, db);

  const list1 = await agent.get('/api/admin/chores');
  assert.equal(list1.status, 200);
  assert.equal(list1.body.chores.length, 0);

  const c = await agent.post('/api/admin/chores').send({
    title: 'Make bed', points: 5, recurs: 'daily', anti_cheat: 'honor',
  });
  assert.equal(c.status, 200);
  const id = c.body.chore.id;

  const patched = await agent.patch(`/api/admin/chores/${id}`).send({ points: 10 });
  assert.equal(patched.body.chore.points, 10);

  const del = await agent.delete(`/api/admin/chores/${id}`);
  assert.equal(del.status, 200);

  // Deleted chores hidden from list by default
  const list2 = await agent.get('/api/admin/chores');
  assert.equal(list2.body.chores.length, 0);

  // But still in DB (soft-delete)
  const row = db.prepare('SELECT deleted_at FROM chores WHERE id = ?').get(id);
  assert.ok(row.deleted_at);
});

test('deleting a chore removes its pending assignments but keeps done ones as history', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await asParent(app, db);

  const c = await agent.post('/api/admin/chores').send({
    title: 'Sweep', points: 5, recurs: 'daily', anti_cheat: 'honor',
    default_assignees: String(kid),
  });
  const choreId = c.body.chore.id;

  // Materialize today's pending + a fake done assignment from yesterday
  db.prepare(`
    INSERT INTO assignments (chore_id, person_id, due_date, status)
    VALUES (?, ?, date('now', 'localtime', '-1 day'), 'done')
  `).run(choreId, kid);

  // confirm at least 2 assignments exist (today pending + yesterday done)
  const before = db.prepare('SELECT COUNT(*) AS c FROM assignments WHERE chore_id = ?').get(choreId).c;
  assert.ok(before >= 2, `expected at least 2 assignments, got ${before}`);

  const del = await agent.delete(`/api/admin/chores/${choreId}`);
  assert.equal(del.status, 200);
  assert.ok(del.body.removed_assignments >= 1, 'should report removed count');

  const remaining = db.prepare('SELECT status FROM assignments WHERE chore_id = ?').all(choreId);
  assert.ok(remaining.every(a => a.status === 'done'), 'only done assignments survive');
  assert.ok(remaining.length >= 1, 'at least one done assignment kept as history');
});

test('chore POST/PATCH accepts weight (1-5) and unstealable', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const agent = await asParent(app, db);

  const c = await agent.post('/api/admin/chores').send({
    title: 'Mow', weight: 5, unstealable: 0, recurs: 'weekly', anti_cheat: 'honor',
  });
  assert.equal(c.status, 200);
  assert.equal(c.body.chore.weight, 5);
  assert.equal(c.body.chore.unstealable, 0);

  const p = await agent.patch(`/api/admin/chores/${c.body.chore.id}`).send({ unstealable: 1, weight: 2 });
  assert.equal(p.body.chore.weight, 2);
  assert.equal(p.body.chore.unstealable, 1);
});

test('chore POST/PATCH accepts is_school_work', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const agent = await asParent(app, db);

  const c = await agent.post('/api/admin/chores').send({
    title: 'Math', weight: 4, is_school_work: 1, recurs: 'daily', anti_cheat: 'honor',
  });
  assert.equal(c.status, 200);
  assert.equal(c.body.chore.is_school_work, 1);

  const p = await agent.patch(`/api/admin/chores/${c.body.chore.id}`).send({ is_school_work: 0 });
  assert.equal(p.status, 200);
  assert.equal(p.body.chore.is_school_work, 0);
});

test('POST bonus with min/max/days seeds current_points=min and ripens_from=today', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const r = await agent.post('/api/admin/chores').send({
    title: 'Wash car', kind: 'bonus', points: 5,
    min_points: 2, max_points: 12, days_to_ripen: 5,
  });
  assert.equal(r.status, 200);
  const row = db.prepare("SELECT min_points, max_points, current_points, days_to_ripen, ripens_from FROM chores WHERE title='Wash car'").get();
  assert.equal(row.min_points, 2);
  assert.equal(row.max_points, 12);
  assert.equal(row.current_points, 2);
  assert.equal(row.days_to_ripen, 5);
  assert.ok(row.ripens_from);
});

test('POST rejects max_points < min_points', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const r = await agent.post('/api/admin/chores').send({
    title: 'Bad', kind: 'bonus', points: 5,
    min_points: 10, max_points: 2,
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /max_points/);
});

test('POST rejects days_to_ripen outside 1..30', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const a = await agent.post('/api/admin/chores').send({ title: 'A', kind: 'bonus', points: 1, min_points: 1, max_points: 2, days_to_ripen: 0 });
  assert.equal(a.status, 400);
  const b = await agent.post('/api/admin/chores').send({ title: 'B', kind: 'bonus', points: 1, min_points: 1, max_points: 2, days_to_ripen: 31 });
  assert.equal(b.status, 400);
});

test('PATCH bonus changing min resets current_points and ripens_from', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const created = (await agent.post('/api/admin/chores').send({
    title: 'C', kind: 'bonus', points: 1, min_points: 1, max_points: 10, days_to_ripen: 5,
  })).body.chore;
  // Manually advance current_points as if a sweep had ripened it.
  db.prepare("UPDATE chores SET current_points = 6 WHERE id = ?").run(created.id);
  const r = await agent.patch(`/api/admin/chores/${created.id}`).send({ min_points: 3, max_points: 12 });
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT current_points, ripens_full_on FROM chores WHERE id = ?').get(created.id);
  assert.equal(row.current_points, 3);
  assert.equal(row.ripens_full_on, null);
});
