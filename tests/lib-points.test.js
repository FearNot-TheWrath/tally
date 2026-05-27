import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { calcWeekPoints, calcProjectedPay } from '../src/lib/points.js';
import { weekStart, today } from '../src/lib/dates.js';

function seedKid(db, name = 'K', target = 100) {
  return db.prepare(
    "INSERT INTO people (name, role, weekly_target_pts, base_pay_cents, bonus_rate_cents) VALUES (?, 'kid', ?, 1000, 10) RETURNING id"
  ).get(name, target).id;
}
function seedChore(db, weight, isSchool = 0) {
  return db.prepare(
    "INSERT INTO chores (title, weight, is_school_work, recurs) VALUES ('T', ?, ?, 'daily') RETURNING id"
  ).get(weight, isSchool).id;
}
function seedAssignment(db, choreId, kidId, dueDate, status = 'pending', extras = {}) {
  const cols = ['chore_id', 'person_id', 'due_date', 'status'];
  const vals = [choreId, kidId, dueDate, status];
  for (const [k, v] of Object.entries(extras)) {
    cols.push(k); vals.push(v);
  }
  return db.prepare(`INSERT INTO assignments (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')}) RETURNING id`).get(...vals).id;
}

test('calcWeekPoints with no assignments returns zeros', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const r = calcWeekPoints(db, kid, weekStart(today()));
  assert.deepEqual(r, { totalWeight: 0, doneWeight: 0, percent: 0, points: 0 });
});

test('calcWeekPoints sums weights and computes percent', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const ws = weekStart(today());
  const c1 = seedChore(db, 3);
  const c2 = seedChore(db, 2);
  seedAssignment(db, c1, kid, today(), 'done');
  seedAssignment(db, c2, kid, today(), 'pending');
  const r = calcWeekPoints(db, kid, ws);
  assert.equal(r.totalWeight, 5);
  assert.equal(r.doneWeight, 3);
  assert.equal(r.percent, 0.6);
  assert.equal(r.points, 60);
});

test('calcWeekPoints counts stolen-away in denominator (original kid still on the hook)', () => {
  const db = freshDb();
  const original = seedKid(db, 'Original');
  const stealer = seedKid(db, 'Stealer');
  const ws = weekStart(today());
  const c = seedChore(db, 4);
  seedAssignment(db, c, stealer, today(), 'pending', { stolen_from: original });
  const r = calcWeekPoints(db, original, ws);
  assert.equal(r.totalWeight, 4, 'stolen-away weight stays in denominator');
  assert.equal(r.doneWeight, 0);
  assert.equal(r.percent, 0);
});

test('calcWeekPoints counts stolen-in in done but NOT in total (extra credit)', () => {
  const db = freshDb();
  const original = seedKid(db, 'Original');
  const stealer = seedKid(db, 'Stealer');
  const ws = weekStart(today());
  const own = seedChore(db, 5);
  const stolen = seedChore(db, 2);
  seedAssignment(db, own, stealer, today(), 'done');
  seedAssignment(db, stolen, stealer, today(), 'done', { stolen_from: original });
  const r = calcWeekPoints(db, stealer, ws);
  assert.equal(r.totalWeight, 5, 'stolen-in does NOT enter denominator');
  assert.equal(r.doneWeight, 7, 'stolen-in done DOES enter numerator');
  assert.equal(r.percent, 1.4);
  assert.equal(r.points, 140);
});

test('calcProjectedPay returns base for 100%, base+bonus for >100%, prorated for <100%', () => {
  const person = { weekly_target_pts: 100, base_pay_cents: 1000, bonus_rate_cents: 10 };

  assert.equal(calcProjectedPay(person, 50), 500, 'half = $5');
  assert.equal(calcProjectedPay(person, 100), 1000, 'target = $10 base');
  assert.equal(calcProjectedPay(person, 106), 1060, '106 pts = base + 6 * 10c = $10.60');
  assert.equal(calcProjectedPay(person, 0), 0, 'no progress = $0');
});

test('calcProjectedPay handles zero target gracefully', () => {
  const person = { weekly_target_pts: 0, base_pay_cents: 1000, bonus_rate_cents: 10 };
  assert.equal(calcProjectedPay(person, 0), 0);
});

test('calcWeekPoints forecasts future days when chore has the kid in default_assignees', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const ws = weekStart(today());
  // Daily chore with this kid in default_assignees, weight 2. Nothing materialized.
  db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('Daily', 2, 'daily', ?)").run(String(kid));
  const r = calcWeekPoints(db, kid, ws);
  assert.equal(r.totalWeight, 14, 'forecast 7 days × weight 2 = 14');
  assert.equal(r.doneWeight, 0);
});

test('calcWeekPoints mixes materialized days with forecast for the rest', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const ws = weekStart(today());
  const cId = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('Daily', 2, 'daily', ?) RETURNING id").get(String(kid)).id;
  // Today: materialize 1 done assignment for this chore
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now', 'localtime'), 'done')").run(cId, kid);
  const r = calcWeekPoints(db, kid, ws);
  // Today is materialized (weight 2); the other 6 days are forecast (6 × 2 = 12)
  assert.equal(r.totalWeight, 14);
  assert.equal(r.doneWeight, 2);
});

test('calcWeekPoints forecast respects weekly day-of-week filter', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const ws = weekStart(today());
  // Weekly chore on Monday only (dow = 1)
  db.prepare("INSERT INTO chores (title, weight, recurs, recurs_days, default_assignees) VALUES ('Mon-only', 3, 'weekly', '1', ?)").run(String(kid));
  const r = calcWeekPoints(db, kid, ws);
  assert.equal(r.totalWeight, 3, 'only Monday should count in the forecast');
});

test('calcWeekPoints forecast skips deleted chores', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const ws = weekStart(today());
  db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees, deleted_at) VALUES ('Gone', 5, 'daily', ?, datetime('now'))").run(String(kid));
  const r = calcWeekPoints(db, kid, ws);
  assert.equal(r.totalWeight, 0);
});
