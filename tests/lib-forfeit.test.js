import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { sweepForfeits, _resetCache } from '../src/lib/forfeit.js';
import { today, toIso } from '../src/lib/dates.js';

function seedKid(db) {
  return db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
}
function seedSchoolChore(db, isSchool = 1) {
  return db.prepare(
    "INSERT INTO chores (title, weight, recurs, default_assignees, is_school_work) VALUES ('Math',3,'daily','',?) RETURNING id"
  ).get(isSchool).id;
}
function seedAssignment(db, choreId, kidId, dueDate, status = 'pending') {
  return db.prepare(
    "INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, ?) RETURNING id"
  ).get(choreId, kidId, dueDate, status).id;
}
function daysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n); return toIso(d);
}
function setDeadline(db, hhmm) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('school_deadline_time', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(hhmm);
}

test('sweepForfeits flips pending school chore on today past the deadline', () => {
  _resetCache();
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedSchoolChore(db, 1);
  const aId = seedAssignment(db, c, kid, today(), 'pending');
  setDeadline(db, '00:00');
  sweepForfeits(db);
  const row = db.prepare('SELECT forfeited FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.forfeited, 1);
});

test('sweepForfeits does NOT touch non-school chores', () => {
  _resetCache();
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedSchoolChore(db, 0);
  const aId = seedAssignment(db, c, kid, today(), 'pending');
  setDeadline(db, '00:00');
  sweepForfeits(db);
  const row = db.prepare('SELECT forfeited FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.forfeited, 0);
});

test('sweepForfeits does NOT touch done chores', () => {
  _resetCache();
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedSchoolChore(db, 1);
  const aId = seedAssignment(db, c, kid, today(), 'done');
  setDeadline(db, '00:00');
  sweepForfeits(db);
  const row = db.prepare('SELECT forfeited FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.forfeited, 0);
});

test('sweepForfeits flips pending school chore from a past day', () => {
  _resetCache();
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedSchoolChore(db, 1);
  const aId = seedAssignment(db, c, kid, daysAgo(1), 'pending');
  setDeadline(db, '00:00');
  sweepForfeits(db);
  const row = db.prepare('SELECT forfeited FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.forfeited, 1);
});

test('sweepForfeits does NOT flip today when before the deadline', () => {
  _resetCache();
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedSchoolChore(db, 1);
  const aId = seedAssignment(db, c, kid, today(), 'pending');
  setDeadline(db, '23:59');
  sweepForfeits(db);
  const row = db.prepare('SELECT forfeited FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.forfeited, 0);
});

test('sweepForfeits is idempotent (running twice does nothing extra)', () => {
  _resetCache();
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedSchoolChore(db, 1);
  const aId = seedAssignment(db, c, kid, today(), 'pending');
  setDeadline(db, '00:00');
  sweepForfeits(db);
  _resetCache();
  sweepForfeits(db);
  const row = db.prepare('SELECT forfeited FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.forfeited, 1);
});
