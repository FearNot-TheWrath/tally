import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { currentStreak, streakAtRisk, isOnFreeze } from '../src/lib/streak.js';
import { today, toIso, fromIso } from '../src/lib/dates.js';

function seedKid(db, name = 'K') {
  return db.prepare("INSERT INTO people (name, role) VALUES (?, 'kid') RETURNING id").get(name).id;
}

function seedChore(db) {
  return db.prepare(
    "INSERT INTO chores (title, points, recurs, default_assignees) VALUES ('T', 3, 'daily', '') RETURNING id"
  ).get().id;
}

function seedAssignment(db, choreId, kidId, dueDate, status = 'pending') {
  return db.prepare(
    "INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, ?) RETURNING id"
  ).get(choreId, kidId, dueDate, status).id;
}

function setFreeze(db, kidId, startIso, endIso) {
  db.prepare("UPDATE people SET freeze_start = ?, freeze_end = ? WHERE id = ?")
    .run(startIso, endIso, kidId);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toIso(d);
}

test('currentStreak with no assignments returns 0', () => {
  const db = freshDb();
  const kid = seedKid(db);
  assert.equal(currentStreak(db, kid), 0);
});

test('currentStreak with today partly done does not break the streak (in-progress)', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c1 = seedChore(db);
  const c2 = seedChore(db);
  seedAssignment(db, c1, kid, daysAgo(1), 'done');
  seedAssignment(db, c1, kid, today(), 'done');
  seedAssignment(db, c2, kid, today(), 'pending');
  assert.equal(currentStreak(db, kid), 1);
});

test('currentStreak with today fully done counts today', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, daysAgo(1), 'done');
  seedAssignment(db, c, kid, today(), 'done');
  assert.equal(currentStreak(db, kid), 2);
});

test('currentStreak: a non-frozen incomplete past day breaks the streak', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, daysAgo(3), 'pending');
  seedAssignment(db, c, kid, daysAgo(2), 'done');
  seedAssignment(db, c, kid, daysAgo(1), 'done');
  seedAssignment(db, c, kid, today(), 'done');
  assert.equal(currentStreak(db, kid), 3);
});

test('currentStreak: a frozen day in the middle is transparent', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, daysAgo(1), 'pending');
  seedAssignment(db, c, kid, daysAgo(2), 'done');
  seedAssignment(db, c, kid, today(), 'done');
  setFreeze(db, kid, daysAgo(1), daysAgo(1));
  assert.equal(currentStreak(db, kid), 2);
});

test('currentStreak with today frozen: walks back transparently', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, daysAgo(1), 'done');
  seedAssignment(db, c, kid, today(), 'pending');
  setFreeze(db, kid, today(), today());
  assert.equal(currentStreak(db, kid), 1);
});

test('currentStreak: a day with zero assignments qualifies vacuously', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, today(), 'done');
  seedAssignment(db, c, kid, daysAgo(2), 'done');
  assert.equal(currentStreak(db, kid), 3);
});

test('currentStreak: safety cap stops a runaway loop', () => {
  const db = freshDb();
  const kid = seedKid(db);
  setFreeze(db, kid, '1900-01-01', '2099-12-31');
  const result = currentStreak(db, kid);
  assert.equal(typeof result, 'number');
  assert.ok(result >= 0);
});

test('isOnFreeze: true when today between bounds', () => {
  const db = freshDb();
  const kid = seedKid(db);
  setFreeze(db, kid, daysAgo(1), daysAgo(-1));
  assert.equal(isOnFreeze(db, kid), true);
});

test('isOnFreeze: false when no bounds set', () => {
  const db = freshDb();
  const kid = seedKid(db);
  assert.equal(isOnFreeze(db, kid), false);
});

test('isOnFreeze: false when only one bound set', () => {
  const db = freshDb();
  const kid = seedKid(db);
  db.prepare("UPDATE people SET freeze_start = ? WHERE id = ?").run(today(), kid);
  assert.equal(isOnFreeze(db, kid), false);
});

test('isOnFreeze: false when date is outside the range', () => {
  const db = freshDb();
  const kid = seedKid(db);
  setFreeze(db, kid, daysAgo(10), daysAgo(5));
  assert.equal(isOnFreeze(db, kid), false);
});

test('streakAtRisk: false when streak is 0', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, today(), 'pending');
  assert.equal(streakAtRisk(db, kid, '00:00', 0), false);
});

test('streakAtRisk: false before warning time', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, today(), 'pending');
  assert.equal(streakAtRisk(db, kid, '23:59', 5), false);
});

test('streakAtRisk: false when today is frozen', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, today(), 'pending');
  setFreeze(db, kid, today(), today());
  assert.equal(streakAtRisk(db, kid, '00:00', 5), false);
});

test('streakAtRisk: false when all today chores done', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, today(), 'done');
  assert.equal(streakAtRisk(db, kid, '00:00', 5), false);
});

test('streakAtRisk: true when streak>0, past warning, not frozen, chores pending', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, today(), 'pending');
  assert.equal(streakAtRisk(db, kid, '00:00', 5), true);
});
