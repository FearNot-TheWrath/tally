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
    VALUES (?, ?, date('now', '-1 day'), 'done')
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

test('chore POST/PATCH accepts weight (1-5) and is_school_work', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const agent = await asParent(app, db);

  const c = await agent.post('/api/admin/chores').send({
    title: 'Mow', weight: 5, is_school_work: 0, recurs: 'weekly', anti_cheat: 'honor',
  });
  assert.equal(c.status, 200);
  assert.equal(c.body.chore.weight, 5);
  assert.equal(c.body.chore.is_school_work, 0);

  const p = await agent.patch(`/api/admin/chores/${c.body.chore.id}`).send({ is_school_work: 1, weight: 2 });
  assert.equal(p.body.chore.weight, 2);
  assert.equal(p.body.chore.is_school_work, 1);
});
