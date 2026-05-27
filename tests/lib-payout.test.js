import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { runPayoutIfDue, _resetCache } from '../src/lib/payout.js';
import { today, toIso, weekStart } from '../src/lib/dates.js';

function seedKid(db, name = 'K', target = 100, basePay = 1000, bonusRate = 10) {
  return db.prepare(
    "INSERT INTO people (name, role, weekly_target_pts, base_pay_cents, bonus_rate_cents) VALUES (?, 'kid', ?, ?, ?) RETURNING id"
  ).get(name, target, basePay, bonusRate).id;
}
function seedChore(db, weight = 3) {
  return db.prepare(
    "INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('T', ?, 'daily', '') RETURNING id"
  ).get(weight).id;
}
function seedDoneAssignment(db, choreId, kidId, dueDate) {
  db.prepare(
    "INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, 'done')"
  ).run(choreId, kidId, dueDate);
}
function setPayoutSettings(db, day, time) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('payout_day', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(day);
  db.prepare("INSERT INTO settings (key, value) VALUES ('payout_time', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(time);
}
function getDeposits(db, kidId) {
  return db.prepare("SELECT * FROM transactions WHERE person_id = ? AND type = 'deposit' ORDER BY created_at").all(kidId);
}
function dayName(d) {
  return ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][d.getDay()];
}

test('runPayoutIfDue does not deposit for the current week before payout time', () => {
  _resetCache();
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  const todayDate = new Date();
  seedDoneAssignment(db, c, kid, today());
  setPayoutSettings(db, dayName(todayDate), '23:59');
  runPayoutIfDue(db);
  const thisWs = weekStart(today());
  const thisWeekDeposit = db.prepare(
    "SELECT 1 FROM transactions WHERE person_id = ? AND type = 'deposit' AND week_start = ?"
  ).get(kid, thisWs);
  assert.equal(thisWeekDeposit, undefined);
});

test('runPayoutIfDue deposits for all kids when past boundary', () => {
  _resetCache();
  const db = freshDb();
  const kid1 = seedKid(db, 'A');
  const kid2 = seedKid(db, 'B');
  const c = seedChore(db);
  const lastMonday = new Date();
  const dow = lastMonday.getDay();
  lastMonday.setDate(lastMonday.getDate() - (dow === 0 ? 6 : dow - 1) - 7);
  for (let i = 0; i < 7; i++) {
    const d = new Date(lastMonday);
    d.setDate(d.getDate() + i);
    seedDoneAssignment(db, c, kid1, toIso(d));
    seedDoneAssignment(db, c, kid2, toIso(d));
  }
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  setPayoutSettings(db, dayName(yesterday), '00:00');
  runPayoutIfDue(db);
  assert.ok(getDeposits(db, kid1).length >= 1);
  assert.ok(getDeposits(db, kid2).length >= 1);
});

test('double-deposit prevention: calling twice creates only one deposit per kid per week', () => {
  _resetCache();
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  const lastMonday = new Date();
  const dow = lastMonday.getDay();
  lastMonday.setDate(lastMonday.getDate() - (dow === 0 ? 6 : dow - 1) - 7);
  seedDoneAssignment(db, c, kid, toIso(lastMonday));
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  setPayoutSettings(db, dayName(yesterday), '00:00');
  runPayoutIfDue(db);
  _resetCache();
  runPayoutIfDue(db);
  const deposits = getDeposits(db, kid);
  const ws = weekStart(toIso(lastMonday));
  const forWeek = deposits.filter(d => d.week_start === ws);
  assert.equal(forWeek.length, 1);
});

test('bank_cents reflects deposited amount', () => {
  _resetCache();
  const db = freshDb();
  const kid = seedKid(db, 'K', 100, 1000, 0);
  const c = seedChore(db);
  const lastMonday = new Date();
  const dow = lastMonday.getDay();
  lastMonday.setDate(lastMonday.getDate() - (dow === 0 ? 6 : dow - 1) - 7);
  for (let i = 0; i < 7; i++) {
    const d = new Date(lastMonday);
    d.setDate(d.getDate() + i);
    seedDoneAssignment(db, c, kid, toIso(d));
  }
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  setPayoutSettings(db, dayName(yesterday), '00:00');
  runPayoutIfDue(db);
  const person = db.prepare('SELECT bank_cents FROM people WHERE id = ?').get(kid);
  assert.ok(person.bank_cents > 0);
  const ws = weekStart(toIso(lastMonday));
  const deposit = db.prepare(
    "SELECT * FROM transactions WHERE person_id = ? AND type = 'deposit' AND week_start = ?"
  ).get(kid, ws);
  assert.ok(deposit);
  assert.equal(deposit.amount_cents, person.bank_cents);
});
