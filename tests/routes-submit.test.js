import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { freshApp, freshDb } from './helpers.js';

function seedChore(db, antiCheat, kidId) {
  return db.prepare(`
    INSERT INTO chores (title, points, recurs, default_assignees, anti_cheat)
    VALUES ('Test', 5, 'daily', ?, ?) RETURNING id
  `).get(String(kidId), antiCheat).id;
}
function seedAssignment(db, choreId, kidId) {
  return db.prepare(`
    INSERT INTO assignments (chore_id, person_id, due_date, status)
    VALUES (?, ?, date('now', 'localtime'), 'pending') RETURNING id
  `).get(choreId, kidId).id;
}
async function loginKid(app, kidId) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: kidId });
  return agent;
}
async function jpeg() {
  return await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 0, g: 255, b: 0 } },
  }).jpeg().toBuffer();
}

test('submit on honor chore moves status to done', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const cId = seedChore(db, 'honor', kid);
  const aId = seedAssignment(db, cId, kid);
  const app = freshApp(db);
  const agent = await loginKid(app, kid);

  const res = await agent.post(`/api/assignments/${aId}/submit`);
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT status FROM assignments WHERE id = ?').get(aId).status, 'done');
});

test('submit on approval chore moves status to submitted', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const cId = seedChore(db, 'approval', kid);
  const aId = seedAssignment(db, cId, kid);
  const app = freshApp(db);
  const agent = await loginKid(app, kid);

  const res = await agent.post(`/api/assignments/${aId}/submit`).send({ note: 'finished' });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT * FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'submitted');
  assert.equal(row.note, 'finished');
  assert.ok(row.submitted_at);
});

test('submit on photo chore without a photo rejects with 400', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const cId = seedChore(db, 'photo', kid);
  const aId = seedAssignment(db, cId, kid);
  const app = freshApp(db);
  const agent = await loginKid(app, kid);

  const res = await agent.post(`/api/assignments/${aId}/submit`);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /at least one photo/i);
});

test('submit on photo chore WITH photo stores file and sets submitted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tally-submit-'));
  try {
    const db = freshDb();
    const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
    const cId = seedChore(db, 'photo', kid);
    const aId = seedAssignment(db, cId, kid);
    const app = freshApp(db, { uploadsDir: root });
    const agent = await loginKid(app, kid);

    const res = await agent.post(`/api/assignments/${aId}/submit`)
      .attach('photo', await jpeg(), { filename: 'cam.jpg', contentType: 'image/jpeg' });
    assert.equal(res.status, 200);
    const row = db.prepare('SELECT * FROM assignments WHERE id = ?').get(aId);
    assert.equal(row.status, 'submitted');
    const photos = db.prepare('SELECT * FROM assignment_photos WHERE assignment_id = ?').all(aId);
    assert.equal(photos.length, 1);
    assert.ok(photos[0].path.endsWith(`${aId}-1.jpg`));
    assert.ok(existsSync(photos[0].path));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('submit on photo chore accepts up to 3 photos', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tally-submit-'));
  try {
    const db = freshDb();
    const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
    const cId = seedChore(db, 'photo', kid);
    const aId = seedAssignment(db, cId, kid);
    const app = freshApp(db, { uploadsDir: root });
    const agent = await loginKid(app, kid);
    const res = await agent.post(`/api/assignments/${aId}/submit`)
      .attach('photo', await jpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' })
      .attach('photo', await jpeg(), { filename: 'b.jpg', contentType: 'image/jpeg' });
    assert.equal(res.status, 200);
    const photos = db.prepare('SELECT * FROM assignment_photos WHERE assignment_id = ?').all(aId);
    assert.equal(photos.length, 2);
    for (const p of photos) assert.ok(existsSync(p.path));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('re-submitting a photo chore with fewer photos clears the orphaned ones', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tally-submit-'));
  try {
    const db = freshDb();
    const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
    const cId = seedChore(db, 'photo', kid);
    const aId = seedAssignment(db, cId, kid);
    const app = freshApp(db, { uploadsDir: root });
    const agent = await loginKid(app, kid);
    // First submit: 2 photos -> slots 1 and 2.
    await agent.post(`/api/assignments/${aId}/submit`)
      .attach('photo', await jpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' })
      .attach('photo', await jpeg(), { filename: 'b.jpg', contentType: 'image/jpeg' });
    const first = db.prepare('SELECT path FROM assignment_photos WHERE assignment_id = ? ORDER BY id').all(aId);
    assert.equal(first.length, 2);
    const slot2Path = first[1].path; // the soon-to-be-orphaned slot-2 file
    db.prepare("UPDATE assignments SET status = 'pending' WHERE id = ?").run(aId);
    // Re-submit with just 1 photo -> only slot 1 remains.
    await agent.post(`/api/assignments/${aId}/submit`)
      .attach('photo', await jpeg(), { filename: 'c.jpg', contentType: 'image/jpeg' });
    const after = db.prepare('SELECT path FROM assignment_photos WHERE assignment_id = ?').all(aId);
    assert.equal(after.length, 1);
    assert.equal(existsSync(slot2Path), false); // orphaned slot-2 file removed
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('submit rejects assignment belonging to another kid', async () => {
  const db = freshDb();
  const a = db.prepare("INSERT INTO people (name, role) VALUES ('A','kid') RETURNING id").get().id;
  const b = db.prepare("INSERT INTO people (name, role) VALUES ('B','kid') RETURNING id").get().id;
  const cId = seedChore(db, 'honor', a);
  const aId = seedAssignment(db, cId, a);
  const app = freshApp(db);
  const agent = await loginKid(app, b);

  const res = await agent.post(`/api/assignments/${aId}/submit`);
  assert.equal(res.status, 403);
});
