import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';
import { generateForToday } from '../src/lib/assignments.js';

test('GET /api/wall returns roster + today/overdue assignments (no auth)', async () => {
  const db = freshDb();
  const gabriel = db.prepare("INSERT INTO people (name, role) VALUES ('Gabriel','kid') RETURNING id").get().id;
  const olivia = db.prepare("INSERT INTO people (name, role) VALUES ('Olivia','kid') RETURNING id").get().id;
  db.prepare(`INSERT INTO chores (title, points, recurs, default_assignees) VALUES ('Bed', 5, 'daily', ?)`).run(`${gabriel},${olivia}`);
  generateForToday(db);

  const res = await request(freshApp(db)).get('/api/wall');
  assert.equal(res.status, 200);
  assert.equal(res.body.kids.length, 2);
  const g = res.body.kids.find(k => k.name === 'Gabriel');
  assert.equal(g.today.length, 1);
  assert.equal(g.today[0].title, 'Bed');
  assert.equal(typeof res.body.house_pct, 'number');
});

test('GET /api/wall populates per-kid points, percent, and stolen_from_name on stolen rows', async () => {
  const db = freshDb();
  const a = db.prepare("INSERT INTO people (name, role, weekly_target_pts) VALUES ('A','kid',100) RETURNING id").get().id;
  const b = db.prepare("INSERT INTO people (name, role, weekly_target_pts) VALUES ('B','kid',100) RETURNING id").get().id;
  const c1 = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('X',2,'daily',?) RETURNING id").get(String(a)).id;
  // assignment given to B, but stolen from A
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status, stolen_from) VALUES (?, ?, date('now', 'localtime'), 'pending', ?)").run(c1, b, a);

  const res = await request(freshApp(db)).get('/api/wall');
  assert.equal(res.status, 200);
  const kidA = res.body.kids.find(k => k.name === 'A');
  const kidB = res.body.kids.find(k => k.name === 'B');
  assert.ok(typeof kidA.points === 'number');
  assert.ok(typeof kidA.percent === 'number');
  // A's denominator includes the stolen-away weight (2); their percent = 0
  assert.equal(kidA.percent, 0);
  // B's view shows the chore with stolen_from_name = 'A'
  const stolenRow = kidB.today.find(t => t.title === 'X');
  assert.ok(stolenRow);
  assert.equal(stolenRow.stolen_from_name, 'A');
});

test('GET /api/wall populates per-kid streak_days and on_freeze', async () => {
  const db = freshDb();
  const a = db.prepare("INSERT INTO people (name, role, weekly_target_pts) VALUES ('A','kid',100) RETURNING id").get().id;
  const b = db.prepare("INSERT INTO people (name, role, weekly_target_pts) VALUES ('B','kid',100) RETURNING id").get().id;
  const c = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('T', 3, 'daily', '') RETURNING id").get().id;
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now', 'localtime', '-1 day'), 'done')").run(c, a);
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now', 'localtime'), 'done')").run(c, a);
  db.prepare("UPDATE people SET freeze_start = date('now', 'localtime'), freeze_end = date('now', 'localtime') WHERE id = ?").run(b);

  const res = await request(freshApp(db)).get('/api/wall');
  assert.equal(res.status, 200);
  const kidA = res.body.kids.find(k => k.name === 'A');
  const kidB = res.body.kids.find(k => k.name === 'B');
  assert.equal(kidA.streak_days, 2);
  assert.equal(kidA.on_freeze, false);
  assert.equal(kidB.on_freeze, true);
});

test('GET /api/wall returns streak_leader for the kid with the highest streak', async () => {
  const db = freshDb();
  const a = db.prepare("INSERT INTO people (name, role, weekly_target_pts, avatar_color) VALUES ('A','kid',100,'#22C55E') RETURNING id").get().id;
  const b = db.prepare("INSERT INTO people (name, role, weekly_target_pts, avatar_color) VALUES ('B','kid',100,'#D4A017') RETURNING id").get().id;
  const c = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('T', 3, 'daily', '') RETURNING id").get().id;
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now', 'localtime'), 'done')").run(c, a);
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now', 'localtime'), 'done')").run(c, b);
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now', 'localtime', '-1 day'), 'done')").run(c, b);
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now', 'localtime', '-2 day'), 'done')").run(c, b);

  const res = await request(freshApp(db)).get('/api/wall');
  assert.equal(res.body.streak_leader.name, 'B');
  assert.equal(res.body.streak_leader.streak_days, 3);
  assert.equal(res.body.streak_leader.color, '#D4A017');
});

test('GET /api/wall returns null streak_leader when no kid has a streak', async () => {
  const db = freshDb();
  db.prepare("INSERT INTO people (name, role) VALUES ('A','kid')").run();
  db.prepare("INSERT INTO people (name, role) VALUES ('B','kid')").run();
  const res = await request(freshApp(db)).get('/api/wall');
  assert.equal(res.body.streak_leader, null);
});
