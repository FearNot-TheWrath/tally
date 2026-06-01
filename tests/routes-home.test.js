import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';
import { generateForToday } from '../src/lib/assignments.js';
import { today } from '../src/lib/dates.js';

function setup() {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role, weekly_target_pts) VALUES ('Gabriel','kid',150) RETURNING id").get().id;
  const choreId = db.prepare(`
    INSERT INTO chores (title, points, recurs, default_assignees, anti_cheat)
    VALUES ('Make bed', 5, 'daily', ?, 'honor') RETURNING id
  `).get(String(kid)).id;
  generateForToday(db);
  return { db, kid, choreId, app: freshApp(db) };
}

async function loginAs(app, personId) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: personId });
  return agent;
}

test('GET /api/home returns today\'s + overdue assignments for the kid', async () => {
  const { app, kid } = setup();
  const agent = await loginAs(app, kid);
  const res = await agent.get('/api/home');
  assert.equal(res.status, 200);
  assert.equal(res.body.person.name, 'Gabriel');
  assert.equal(res.body.today.length, 1);
  assert.equal(res.body.today[0].title, 'Make bed');
  assert.equal(res.body.today[0].status, 'pending');
});

test('POST /api/assignments/:id/done flips status to done', async () => {
  const { app, kid, db } = setup();
  const agent = await loginAs(app, kid);
  const a = db.prepare("SELECT id FROM assignments WHERE person_id = ?").get(kid);
  const res = await agent.post(`/api/assignments/${a.id}/done`);
  assert.equal(res.status, 200);
  const after = db.prepare('SELECT status FROM assignments WHERE id = ?').get(a.id);
  assert.equal(after.status, 'done');
});

test('cannot mark someone else\'s assignment done', async () => {
  const { app, db } = setup();
  const other = db.prepare("INSERT INTO people (name, role) VALUES ('Olivia','kid') RETURNING id").get().id;
  const agent = await loginAs(app, other);
  const a = db.prepare("SELECT id FROM assignments").get();
  const res = await agent.post(`/api/assignments/${a.id}/done`);
  assert.equal(res.status, 403);
});

test('GET /api/home rejects unauthenticated requests', async () => {
  const { app } = setup();
  const res = await request(app).get('/api/home');
  assert.equal(res.status, 401);
});

test('GET /api/home populates points_this_week, percent, projected_pay_cents (with forecast)', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role, weekly_target_pts, base_pay_cents, bonus_rate_cents) VALUES ('K','kid',100,1000,10) RETURNING id").get().id;
  const c1 = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees, anti_cheat) VALUES ('A', 3, 'daily', ?, 'honor') RETURNING id").get(String(kid)).id;
  const c2 = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees, anti_cheat) VALUES ('B', 2, 'daily', ?, 'honor') RETURNING id").get(String(kid)).id;
  // Today: c1 done, c2 pending. Other 6 days: forecast both as daily (5/day × 6 = 30).
  // Total week weight = 5 (today materialized) + 30 (forecast) = 35.
  // Done weight = 3. Percent = 3/35 ≈ 0.0857. Points = round(× 100) = 9.
  // Pay derives from rounded points (consistent with what user sees): 9/100 × 1000 = 90 cents.
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now', 'localtime'), 'done')").run(c1, kid);
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now', 'localtime'), 'pending')").run(c2, kid);

  const app = freshApp(db);
  const agent = await loginAs(app, kid);
  const res = await agent.get('/api/home');
  assert.equal(res.status, 200);
  assert.equal(res.body.person.points_this_week, 9);
  assert.equal(res.body.person.projected_pay_cents, 90);
  assert.ok(Array.isArray(res.body.today));
  for (const r of res.body.today) {
    assert.ok(typeof r.display_points === 'number', `display_points missing on ${r.title}`);
  }
});

test('GET /api/home returns covers for a kid when a sibling is frozen with an excused chore', async () => {
  const db = freshDb();
  const frozen = db.prepare("INSERT INTO people (name, role, avatar_color) VALUES ('Gabriel','kid','#22C55E') RETURNING id").get().id;
  const claimer = db.prepare("INSERT INTO people (name, role, weekly_target_pts) VALUES ('Olivia','kid',100) RETURNING id").get().id;
  const c = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('Walk dogs', 3, 'daily', '') RETURNING id").get().id;
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status, note) VALUES (?, ?, ?, 'excused', 'On freeze')").run(c, frozen, today());
  db.prepare("UPDATE people SET freeze_start = ?, freeze_end = ? WHERE id = ?").run(today(), today(), frozen);

  const app = freshApp(db);
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: claimer });

  const res = await agent.get('/api/home');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.covers));
  assert.equal(res.body.covers.length, 1);
  assert.equal(res.body.covers[0].owner_name, 'Gabriel');
  assert.equal(res.body.covers[0].owner_color, '#22C55E');
  assert.equal(res.body.covers[0].title, 'Walk dogs');
});

test('GET /api/home covers excludes excused chores when the owner is NOT on freeze', async () => {
  const db = freshDb();
  const owner = db.prepare("INSERT INTO people (name, role) VALUES ('Gabriel','kid') RETURNING id").get().id;
  const viewer = db.prepare("INSERT INTO people (name, role) VALUES ('Olivia','kid') RETURNING id").get().id;
  const c = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('T',3,'daily','') RETURNING id").get().id;
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, 'excused')").run(c, owner, today());

  const app = freshApp(db);
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: viewer });
  const res = await agent.get('/api/home');
  assert.equal(res.body.covers.length, 0);
});

test("GET /api/home covers excludes the viewer's own excused chores", async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const c = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('T',3,'daily','') RETURNING id").get().id;
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, 'excused')").run(c, kid, today());
  db.prepare("UPDATE people SET freeze_start = ?, freeze_end = ? WHERE id = ?").run(today(), today(), kid);

  const app = freshApp(db);
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: kid });
  const res = await agent.get('/api/home');
  assert.equal(res.body.covers.length, 0);
});

test('GET /api/home covers excludes bonus-kind chores', async () => {
  const db = freshDb();
  const frozen = db.prepare("INSERT INTO people (name, role) VALUES ('Gabriel','kid') RETURNING id").get().id;
  const claimer = db.prepare("INSERT INTO people (name, role) VALUES ('Olivia','kid') RETURNING id").get().id;
  const c = db.prepare("INSERT INTO chores (title, points, kind, recurs, default_assignees) VALUES ('Mow', 10, 'bonus', 'none', '') RETURNING id").get().id;
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, 'excused')").run(c, frozen, today());
  db.prepare("UPDATE people SET freeze_start = ?, freeze_end = ? WHERE id = ?").run(today(), today(), frozen);

  const app = freshApp(db);
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: claimer });
  const res = await agent.get('/api/home');
  assert.equal(res.body.covers.length, 0);
});
