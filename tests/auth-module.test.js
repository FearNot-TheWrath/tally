import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { createSession, getSession, requireRole, verifyParentPin } from '../src/auth.js';

test('createSession returns a token and inserts a row', () => {
  const db = freshDb();
  const personId = db.prepare(
    "INSERT INTO people (name, role) VALUES ('Test', 'kid') RETURNING id"
  ).get().id;
  const token = createSession(db, personId, { ua: 'test' });
  assert.ok(typeof token === 'string' && token.length >= 32);
  const session = getSession(db, token);
  assert.equal(session.person_id, personId);
});

test('verifyParentPin returns true for the default PIN and false otherwise', () => {
  const db = freshDb();
  assert.equal(verifyParentPin(db, '1234'), true);
  assert.equal(verifyParentPin(db, '0000'), false);
});

test('requireRole allows matching role, rejects mismatch', () => {
  const db = freshDb();
  const kidId = db.prepare("INSERT INTO people (name, role) VALUES ('K', 'kid') RETURNING id").get().id;
  const parentId = db.prepare("INSERT INTO people (name, role) VALUES ('P', 'parent') RETURNING id").get().id;

  const allowKid = requireRole('kid');
  const allowParent = requireRole('parent');

  const reqKid = { app: { get: () => db }, session: { token: createSession(db, kidId, {}) } };
  const reqParent = { app: { get: () => db }, session: { token: createSession(db, parentId, {}) } };

  let nextCalled, statusCode;
  const res = { status(c) { statusCode = c; return this; }, json() { return this; } };
  const next = () => { nextCalled = true; };

  // Kid into kid-only: passes.
  nextCalled = false;
  allowKid(reqKid, res, next);
  assert.equal(nextCalled, true);

  // Kid into parent-only: rejected.
  nextCalled = false; statusCode = 0;
  allowParent(reqKid, res, next);
  assert.equal(nextCalled, false);
  assert.equal(statusCode, 403);
});
