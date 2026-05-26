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
