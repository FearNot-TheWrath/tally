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

function seedKid(db, name) {
  return db.prepare("INSERT INTO people (name, role, avatar_color) VALUES (?, 'kid', '#22C55E') RETURNING id").get(name).id;
}

function seedChore(db, title, antiCheat, kidId, points = 5) {
  return db.prepare(`
    INSERT INTO chores (title, points, recurs, default_assignees, anti_cheat)
    VALUES (?, ?, 'daily', ?, ?) RETURNING id
  `).get(title, points, String(kidId), antiCheat).id;
}

function seedAssignment(db, choreId, kidId, dueDate, status, extras = {}) {
  const cols = ['chore_id', 'person_id', 'due_date', 'status'];
  const vals = [choreId, kidId, dueDate, status];
  for (const [k, v] of Object.entries(extras)) {
    cols.push(k);
    vals.push(v);
  }
  return db.prepare(`
    INSERT INTO assignments (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) RETURNING id
  `).get(...vals).id;
}

test('GET /api/admin/day-review?date=... returns photo+approval chores for that day with status info', async () => {
  const db = freshDb();
  const kid = seedKid(db, 'Olivia');
  const cPhoto = seedChore(db, 'Vacuum', 'photo', kid);
  const cApproval = seedChore(db, 'Reading', 'approval', kid);
  const cHonor = seedChore(db, 'Bed', 'honor', kid);

  // Today: photo submitted, approval done, honor done
  seedAssignment(db, cPhoto, kid, '2026-05-26', 'submitted', { photo_path: '/some/path/1.jpg', submitted_at: '2026-05-26 10:00:00' });
  seedAssignment(db, cApproval, kid, '2026-05-26', 'done', { approved_at: '2026-05-26 11:00:00' });
  seedAssignment(db, cHonor, kid, '2026-05-26', 'done');

  // Yesterday: photo rejected (should NOT appear when querying today)
  seedAssignment(db, cPhoto, kid, '2026-05-25', 'rejected', { note: 'too messy' });

  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const res = await agent.get('/api/admin/day-review?date=2026-05-26');
  assert.equal(res.status, 200);

  // Should include the photo + approval chores from today (NOT honor, NOT yesterday)
  assert.equal(res.body.items.length, 2);
  const titles = res.body.items.map(i => i.chore_title).sort();
  assert.deepEqual(titles, ['Reading', 'Vacuum']);

  // photo submitted item should have photo_url
  const vacuum = res.body.items.find(i => i.chore_title === 'Vacuum');
  assert.equal(vacuum.status, 'submitted');
  assert.ok(vacuum.photo_url);

  // approval done item should have approver info, no photo_url
  const reading = res.body.items.find(i => i.chore_title === 'Reading');
  assert.equal(reading.status, 'done');
  assert.equal(reading.photo_url, null);
});

test('day-review without ?date defaults to today', async () => {
  const db = freshDb();
  const kid = seedKid(db, 'K');
  const c = seedChore(db, 'X', 'photo', kid);
  const todayStr = new Date().toISOString().slice(0, 10);
  seedAssignment(db, c, kid, todayStr, 'submitted');
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const res = await agent.get('/api/admin/day-review');
  assert.equal(res.status, 200);
  assert.equal(res.body.date, todayStr);
  assert.equal(res.body.items.length, 1);
});

test('day-review rejects non-parents', async () => {
  const db = freshDb();
  const kid = seedKid(db, 'K');
  const app = freshApp(db);
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: kid });
  const res = await agent.get('/api/admin/day-review');
  assert.equal(res.status, 403);
});

test('day-review with bad date format returns 400', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const res = await agent.get('/api/admin/day-review?date=not-a-date');
  assert.equal(res.status, 400);
});
