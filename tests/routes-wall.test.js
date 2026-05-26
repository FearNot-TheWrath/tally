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
