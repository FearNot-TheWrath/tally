import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshApp, freshDb } from './helpers.js';

async function asParent(app, db) {
  const id = db.prepare("INSERT INTO people (name, role) VALUES ('Mom','parent') RETURNING id").get().id;
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id, pin: '1234' });
  return { agent, id };
}

function seedSubmitted(db, kidId, options = {}) {
  const c = db.prepare(`
    INSERT INTO chores (title, points, recurs, default_assignees, anti_cheat)
    VALUES ('T', 5, 'daily', ?, ?) RETURNING id
  `).get(String(kidId), options.antiCheat || 'photo').id;
  return db.prepare(`
    INSERT INTO assignments (chore_id, person_id, due_date, status, submitted_at, photo_path, note)
    VALUES (?, ?, date('now', 'localtime'), 'submitted', datetime('now'), ?, ?) RETURNING id
  `).get(c, kidId, options.photoPath || null, options.note || '').id;
}

function makeFakeJpeg(root, assignmentId) {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const dir = join(root, ym);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${assignmentId}.jpg`);
  writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff])); // jpeg magic bytes
  return filePath;
}

test('GET /api/admin/approvals returns submitted assignments with kid + chore + photo info', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  seedSubmitted(db, kid, { photoPath: '/some/where/42.jpg' });
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const res = await agent.get('/api/admin/approvals');
  assert.equal(res.status, 200);
  assert.equal(res.body.approvals.length, 1);
  assert.equal(res.body.approvals[0].kid_name, 'K');
  assert.equal(res.body.approvals[0].chore_title, 'T');
  assert.ok(res.body.approvals[0].photo_url);
});

test('approve sets status=done, points_earned, approved_at, approved_by AND deletes photo file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tally-approve-'));
  try {
    const db = freshDb();
    const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
    const aId = seedSubmitted(db, kid);
    const filePath = makeFakeJpeg(root, aId);
    db.prepare('UPDATE assignments SET photo_path = ? WHERE id = ?').run(filePath, aId);
    assert.ok(existsSync(filePath), 'photo file exists before approve');

    const app = freshApp(db, { uploadsDir: root });
    const { agent, id: parentId } = await asParent(app, db);
    const res = await agent.post(`/api/admin/approvals/${aId}/approve`);
    assert.equal(res.status, 200);

    const row = db.prepare('SELECT * FROM assignments WHERE id = ?').get(aId);
    assert.equal(row.status, 'done');
    assert.equal(row.points_earned, 5);
    assert.equal(row.approved_by, parentId);
    assert.ok(row.approved_at);
    assert.equal(row.photo_path, null, 'photo_path nulled');
    assert.equal(existsSync(filePath), false, 'photo file deleted from disk');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('approve with point override sets that points_earned value', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const aId = seedSubmitted(db, kid);
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const res = await agent.post(`/api/admin/approvals/${aId}/approve`).send({ points: 2 });
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT points_earned FROM assignments WHERE id = ?').get(aId).points_earned, 2);
});

test('reject sets status=pending, stores note, AND deletes photo file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tally-reject-'));
  try {
    const db = freshDb();
    const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
    const aId = seedSubmitted(db, kid);
    const filePath = makeFakeJpeg(root, aId);
    db.prepare('UPDATE assignments SET photo_path = ? WHERE id = ?').run(filePath, aId);

    const app = freshApp(db, { uploadsDir: root });
    const { agent } = await asParent(app, db);
    const res = await agent.post(`/api/admin/approvals/${aId}/reject`).send({ note: 'still messy' });
    assert.equal(res.status, 200);

    const row = db.prepare('SELECT * FROM assignments WHERE id = ?').get(aId);
    assert.equal(row.status, 'pending');
    assert.equal(row.note, 'still messy');
    assert.equal(row.photo_path, null, 'photo_path nulled');
    assert.equal(existsSync(filePath), false, 'photo file deleted from disk');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('approve/reject of an assignment with no photo_path still succeeds', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  // approval chore — no photo
  const aId = seedSubmitted(db, kid, { antiCheat: 'approval', photoPath: null });
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const res = await agent.post(`/api/admin/approvals/${aId}/approve`);
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT status FROM assignments WHERE id = ?').get(aId).status, 'done');
});

test('approvals queue rejects non-parents', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: kid });
  const res = await agent.get('/api/admin/approvals');
  assert.equal(res.status, 403);
});

test('photo serving requires auth (parent or owning kid); strangers get 401/403', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tally-served-'));
  try {
    const aId = 99;
    const filePath = makeFakeJpeg(root, aId);
    const ym = filePath.split('/').slice(-2, -1)[0];

    const db = freshDb();
    const owner = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
    const other = db.prepare("INSERT INTO people (name, role) VALUES ('K2','kid') RETURNING id").get().id;
    const cId = db.prepare("INSERT INTO chores (title, points, default_assignees, anti_cheat) VALUES ('X',5,?,'photo') RETURNING id").get(String(owner)).id;
    db.prepare(`
      INSERT INTO assignments (id, chore_id, person_id, due_date, status, photo_path)
      VALUES (?, ?, ?, date('now', 'localtime'), 'submitted', ?)
    `).run(aId, cId, owner, filePath);
    const app = freshApp(db, { uploadsDir: root });

    const r1 = await request(app).get(`/api/uploads/${ym}/${aId}.jpg`);
    assert.equal(r1.status, 401);

    const otherAgent = request.agent(app);
    await otherAgent.post('/api/auth/login').send({ person_id: other });
    const r2 = await otherAgent.get(`/api/uploads/${ym}/${aId}.jpg`);
    assert.equal(r2.status, 403);

    const { agent: parentAgent } = await asParent(app, db);
    const r3 = await parentAgent.get(`/api/uploads/${ym}/${aId}.jpg`);
    assert.equal(r3.status, 200);
    assert.equal(r3.headers['content-type'], 'image/jpeg');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
