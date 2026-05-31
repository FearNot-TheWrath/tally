import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { applyFreezeSweep } from '../src/lib/freeze.js';
import { today, toIso } from '../src/lib/dates.js';

function seedKid(db, name = 'K') {
  return db.prepare("INSERT INTO people (name, role) VALUES (?, 'kid') RETURNING id").get(name).id;
}
function seedChore(db, kind = 'recurring') {
  return db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees, kind) VALUES ('T',3,'daily','',?) RETURNING id").get(kind).id;
}
function seedAssignment(db, choreId, kidId, dueDate, status = 'pending') {
  return db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, ?) RETURNING id").get(choreId, kidId, dueDate, status).id;
}
function setFreeze(db, kidId, startIso, endIso) {
  db.prepare("UPDATE people SET freeze_start = ?, freeze_end = ? WHERE id = ?").run(startIso, endIso, kidId);
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toIso(d);
}
function daysFromNow(n) {
  return daysAgo(-n);
}

test('applyFreezeSweep excuses a pending chore on today when freeze covers today', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  const aId = seedAssignment(db, c, kid, today(), 'pending');
  setFreeze(db, kid, today(), today());
  applyFreezeSweep(db, kid);
  const row = db.prepare('SELECT status, note FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'excused');
  assert.equal(row.note, 'On freeze');
});

test('applyFreezeSweep leaves a done chore alone (today still in window)', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  const aId = seedAssignment(db, c, kid, today(), 'done');
  setFreeze(db, kid, today(), today());
  applyFreezeSweep(db, kid);
  const row = db.prepare('SELECT status FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'done');
});

test('applyFreezeSweep leaves a chore on a past day alone, even if inside freeze range', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  const aId = seedAssignment(db, c, kid, daysAgo(2), 'pending');
  setFreeze(db, kid, daysAgo(3), today());
  applyFreezeSweep(db, kid);
  const row = db.prepare('SELECT status FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'pending');
});

test('applyFreezeSweep excuses a pending chore on a FUTURE day inside the freeze window', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  const aId = seedAssignment(db, c, kid, daysFromNow(2), 'pending');
  setFreeze(db, kid, today(), daysFromNow(3));
  applyFreezeSweep(db, kid);
  const row = db.prepare('SELECT status FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'excused');
});

test('applyFreezeSweep does NOT touch bonus-chore assignments', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db, 'bonus');
  const aId = seedAssignment(db, c, kid, today(), 'pending');
  setFreeze(db, kid, today(), today());
  applyFreezeSweep(db, kid);
  const row = db.prepare('SELECT status FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'pending');
});

test('applyFreezeSweep is a no-op when the kid has no freeze set', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  const aId = seedAssignment(db, c, kid, today(), 'pending');
  applyFreezeSweep(db, kid);
  const row = db.prepare('SELECT status FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'pending');
});

test('applyFreezeSweep is a no-op when freeze_end is already in the past', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  const aId = seedAssignment(db, c, kid, today(), 'pending');
  setFreeze(db, kid, daysAgo(5), daysAgo(2));
  applyFreezeSweep(db, kid);
  const row = db.prepare('SELECT status FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'pending');
});
