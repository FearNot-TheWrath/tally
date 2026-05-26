import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';

async function asParent(app, db) {
  const id = db.prepare("INSERT INTO people (name, role) VALUES ('Mom','parent') RETURNING id").get().id;
  const agent = request.agent(app);
  const r = await agent.post('/api/auth/login').send({ person_id: id, pin: '1234' });
  if (r.status !== 200) throw new Error('parent login failed');
  return agent;
}

test('admin people: list, create, patch (parent only)', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const agent = await asParent(app, db);

  const list1 = await agent.get('/api/admin/people');
  assert.equal(list1.status, 200);
  assert.equal(list1.body.people.length, 1); // just the parent

  const created = await agent.post('/api/admin/people').send({
    name: 'Gabriel', role: 'kid', dob: '2011-01-25',
    weekly_target_pts: 150, base_pay_cents: 1000, bonus_rate_cents: 10,
    avatar_color: '#22C55E',
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.person.name, 'Gabriel');
  assert.equal(created.body.person.weekly_target_pts, 150);

  const patched = await agent.patch(`/api/admin/people/${created.body.person.id}`)
    .send({ weekly_target_pts: 200 });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.person.weekly_target_pts, 200);
});

test('admin people rejects non-parent', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: kid });
  const r = await agent.get('/api/admin/people');
  assert.equal(r.status, 403);
});
