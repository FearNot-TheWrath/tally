import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';

function seed(db) {
  db.prepare("INSERT INTO people (name, role, avatar_color) VALUES ('Gabriel','kid','#22C55E')").run();
  db.prepare("INSERT INTO people (name, role, avatar_color) VALUES ('Mom','parent','#0F172A')").run();
}

test('GET /api/auth/picker lists kids and parents (no auth required)', async () => {
  const db = freshDb();
  seed(db);
  const app = freshApp(db);
  const res = await request(app).get('/api/auth/picker');
  assert.equal(res.status, 200);
  assert.equal(res.body.people.length, 2);
  assert.ok(res.body.people.find(p => p.name === 'Gabriel' && p.role === 'kid'));
});

test('POST /api/auth/login as kid sets cookie, returns ok', async () => {
  const db = freshDb();
  seed(db);
  const app = freshApp(db);
  const kid = db.prepare("SELECT id FROM people WHERE name='Gabriel'").get();
  const res = await request(app).post('/api/auth/login').send({ person_id: kid.id });
  assert.equal(res.status, 200);
  assert.ok(res.headers['set-cookie']?.some(c => c.startsWith('tally_session=')));
});

test('POST /api/auth/login as parent requires PIN', async () => {
  const db = freshDb();
  seed(db);
  const app = freshApp(db);
  const parent = db.prepare("SELECT id FROM people WHERE role='parent'").get();

  const wrong = await request(app).post('/api/auth/login').send({ person_id: parent.id, pin: '0000' });
  assert.equal(wrong.status, 401);

  const right = await request(app).post('/api/auth/login').send({ person_id: parent.id, pin: '1234' });
  assert.equal(right.status, 200);
});

test('GET /api/me returns 401 when not logged in, user payload when logged in', async () => {
  const db = freshDb();
  seed(db);
  const app = freshApp(db);
  const agent = request.agent(app);

  const r1 = await agent.get('/api/me');
  assert.equal(r1.status, 401);

  const kid = db.prepare("SELECT id FROM people WHERE name='Gabriel'").get();
  await agent.post('/api/auth/login').send({ person_id: kid.id });

  const r2 = await agent.get('/api/me');
  assert.equal(r2.status, 200);
  assert.equal(r2.body.name, 'Gabriel');
});

test('POST /api/auth/logout clears the session', async () => {
  const db = freshDb();
  seed(db);
  const app = freshApp(db);
  const agent = request.agent(app);
  const kid = db.prepare("SELECT id FROM people WHERE name='Gabriel'").get();
  await agent.post('/api/auth/login').send({ person_id: kid.id });
  await agent.post('/api/auth/logout');
  const r = await agent.get('/api/me');
  assert.equal(r.status, 401);
});
