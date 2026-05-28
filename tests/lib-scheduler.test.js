import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { streakReminderDue } from '../src/lib/scheduler.js';
import { today, toIso } from '../src/lib/dates.js';

function seedKid(db, name = 'K') {
  return db.prepare("INSERT INTO people (name, role) VALUES (?, 'kid') RETURNING id").get(name).id;
}
function seedChore(db) {
  return db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('T', 3, 'daily', '') RETURNING id").get().id;
}
function seedAssignment(db, choreId, kidId, dueDate, status = 'pending') {
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, ?)").run(choreId, kidId, dueDate, status);
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toIso(d);
}
function setWarning(db, hhmm) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('streak_warning_time', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(hhmm);
}

test('streakReminderDue returns kids at risk after warning time', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, daysAgo(1), 'done');
  seedAssignment(db, c, kid, today(), 'pending');
  setWarning(db, '00:00');
  const due = streakReminderDue(db);
  assert.equal(due.length, 1);
  assert.equal(due[0].personId, kid);
  assert.equal(due[0].streakDays, 1);
});

test('streakReminderDue empty when no kid at risk', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, today(), 'done');
  setWarning(db, '00:00');
  const due = streakReminderDue(db);
  assert.equal(due.length, 0);
});

test('streakReminderDue excludes kids with streak 0', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, today(), 'pending');
  setWarning(db, '00:00');
  const due = streakReminderDue(db);
  assert.equal(due.length, 0);
});
