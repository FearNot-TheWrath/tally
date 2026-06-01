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

import { today } from '../src/lib/dates.js';

test('PATCH /api/admin/people/:id with freeze covering today excuses kid pending chores', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const c = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('T',3,'daily','') RETURNING id").get().id;
  const aId = db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, 'pending') RETURNING id").get(c, kid, today()).id;
  const app = freshApp(db);
  const agent = await asParent(app, db);

  const res = await agent.patch(`/api/admin/people/${kid}`).send({ freeze_start: today(), freeze_end: today() });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT status, note FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'excused');
  assert.equal(row.note, 'On freeze');
});

test('PATCH that does NOT touch freeze fields does NOT excuse any chores', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const c = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('T',3,'daily','') RETURNING id").get().id;
  const aId = db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, 'pending') RETURNING id").get(c, kid, today()).id;
  db.prepare("UPDATE people SET freeze_start = ?, freeze_end = ? WHERE id = ?").run(today(), today(), kid);
  const app = freshApp(db);
  const agent = await asParent(app, db);

  const res = await agent.patch(`/api/admin/people/${kid}`).send({ weekly_target_pts: 75 });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT status FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'pending');
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

test('PATCH /api/admin/people/:id rejects setting only freeze_start without freeze_end (400)', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.patch(`/api/admin/people/${kid}`).send({ freeze_start: today() });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /freeze_start.*freeze_end/i);
});

test('PATCH /api/admin/people/:id rejects setting only freeze_end without freeze_start (400)', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.patch(`/api/admin/people/${kid}`).send({ freeze_end: today() });
  assert.equal(res.status, 400);
});

test('PATCH /api/admin/people/:id rejects half-freeze with one truthy and one empty', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.patch(`/api/admin/people/${kid}`).send({ freeze_start: today(), freeze_end: '' });
  assert.equal(res.status, 400);
});

test('PATCH /api/admin/people/:id accepts both freeze bounds together', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.patch(`/api/admin/people/${kid}`).send({ freeze_start: today(), freeze_end: today() });
  assert.equal(res.status, 200);
});

test('PATCH /api/admin/people/:id accepts clearing both freeze bounds', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role, freeze_start, freeze_end) VALUES ('K','kid',?,?) RETURNING id").get(today(), today()).id;
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.patch(`/api/admin/people/${kid}`).send({ freeze_start: '', freeze_end: '' });
  assert.equal(res.status, 200);
});
