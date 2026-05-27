import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';

async function asParent(app, db) {
  const id = db.prepare("INSERT INTO people (name, role) VALUES ('Mom','parent') RETURNING id").get().id;
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id, pin: '1234' });
  return agent;
}

test('GET /api/admin/bank returns kids with bank_cents and transactions', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role, bank_cents) VALUES ('K','kid', 500) RETURNING id").get().id;
  db.prepare("INSERT INTO transactions (person_id, type, amount_cents, note) VALUES (?, 'deposit', 500, 'Test')").run(kid);
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.get('/api/admin/bank');
  assert.equal(res.status, 200);
  assert.equal(res.body.kids.length, 1);
  assert.equal(res.body.kids[0].bank_cents, 500);
  assert.equal(res.body.kids[0].transactions.length, 1);
  assert.equal(res.body.kids[0].transactions[0].amount_cents, 500);
});

test('POST /api/admin/bank/:id/adjust adds to balance with positive amount', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role, bank_cents) VALUES ('K','kid', 1000) RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.post(`/api/admin/bank/${kid}/adjust`).send({ amount_cents: 500, note: 'Birthday gift' });
  assert.equal(res.status, 200);
  assert.equal(res.body.bank_cents, 1500);
  assert.equal(res.body.transaction.amount_cents, 500);
  assert.equal(res.body.transaction.note, 'Birthday gift');
});

test('POST /api/admin/bank/:id/adjust deducts with negative amount', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role, bank_cents) VALUES ('K','kid', 1000) RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.post(`/api/admin/bank/${kid}/adjust`).send({ amount_cents: -300, note: 'Bought a book' });
  assert.equal(res.status, 200);
  assert.equal(res.body.bank_cents, 700);
  assert.equal(res.body.transaction.amount_cents, -300);
});

test('POST /api/admin/bank/:id/adjust requires note', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.post(`/api/admin/bank/${kid}/adjust`).send({ amount_cents: 100, note: '' });
  assert.equal(res.status, 400);
});

test('POST /api/admin/bank/:id/adjust rejects zero amount', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.post(`/api/admin/bank/${kid}/adjust`).send({ amount_cents: 0, note: 'Nothing' });
  assert.equal(res.status, 400);
});
