import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';
import { generateForToday } from '../src/lib/assignments.js';

async function asParent(app, db) {
  const id = db.prepare("INSERT INTO people (name, role) VALUES ('Mom','parent') RETURNING id").get().id;
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id, pin: '1234' });
  return agent;
}

test('GET /api/admin/today returns counts and a per-kid summary', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('Gabriel','kid') RETURNING id").get().id;
  db.prepare(`INSERT INTO chores (title, points, recurs, default_assignees) VALUES ('Bed',5,'daily',?)`).run(String(kid));
  generateForToday(db);

  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.get('/api/admin/today');
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.house_pct === 'number');
  assert.equal(res.body.kids.length, 1);
  assert.equal(res.body.kids[0].today_total, 1);
});
