import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { sweepBonusRipening, _resetCache, ripeningStep } from '../src/lib/bonus-ripen.js';

function makeBonus(db, { title = 'B', min = 1, max = 10, days = 5, current = null, from = null, fullOn = null } = {}) {
  return db.prepare(`
    INSERT INTO chores
      (title, kind, points, recurs, default_assignees, min_points, max_points, days_to_ripen, current_points, ripens_from, ripens_full_on)
    VALUES (?, 'bonus', ?, 'none', '', ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(title, min, min, max, days, current ?? min, from, fullOn).id;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

test('ripeningStep: linear from min to max over days', () => {
  assert.equal(ripeningStep(1, 10, 5), 2);   // 9/5 = 1.8 -> 2
  assert.equal(ripeningStep(1, 10, 9), 1);   // 9/9 = 1 -> 1
  assert.equal(ripeningStep(5, 5, 5), 0);    // backward-compat (min==max)
  assert.equal(ripeningStep(1, 100, 7), 14); // 99/7 = 14.14 -> 14
});

test('sweep is a no-op when ripens_from == today (already ripened today)', () => {
  _resetCache();
  const db = freshDb();
  const id = makeBonus(db, { min: 1, max: 10, days: 5, current: 3, from: todayIso() });
  sweepBonusRipening(db);
  const row = db.prepare('SELECT current_points, ripens_from FROM chores WHERE id = ?').get(id);
  assert.equal(row.current_points, 3);
});

test('sweep bumps current by step when 1 day has passed', () => {
  _resetCache();
  const db = freshDb();
  const id = makeBonus(db, { min: 1, max: 10, days: 5, current: 1, from: daysAgo(1) });
  sweepBonusRipening(db);
  const row = db.prepare('SELECT current_points, ripens_from FROM chores WHERE id = ?').get(id);
  assert.equal(row.current_points, 3);        // 1 + step(2)
  assert.equal(row.ripens_from, todayIso());  // touched today now
});

test('sweep catches up multi-day gaps in one pass', () => {
  _resetCache();
  const db = freshDb();
  const id = makeBonus(db, { min: 1, max: 10, days: 5, current: 1, from: daysAgo(3) });
  sweepBonusRipening(db);
  const row = db.prepare('SELECT current_points FROM chores WHERE id = ?').get(id);
  // 1 + step*3 = 1 + 2*3 = 7
  assert.equal(row.current_points, 7);
});

test('sweep clamps at max and stamps ripens_full_on the first day it reaches max', () => {
  _resetCache();
  const db = freshDb();
  const id = makeBonus(db, { min: 1, max: 10, days: 5, current: 9, from: daysAgo(1) });
  sweepBonusRipening(db);
  const row = db.prepare('SELECT current_points, ripens_full_on FROM chores WHERE id = ?').get(id);
  assert.equal(row.current_points, 10);
  assert.equal(row.ripens_full_on, todayIso());
});

test('sweep soft-deletes a bonus that has been at max since at least yesterday', () => {
  _resetCache();
  const db = freshDb();
  const id = makeBonus(db, { min: 1, max: 10, days: 5, current: 10, from: daysAgo(2), fullOn: daysAgo(1) });
  sweepBonusRipening(db);
  const row = db.prepare('SELECT deleted_at FROM chores WHERE id = ?').get(id);
  assert.ok(row.deleted_at, 'should be soft-deleted');
});

test('sweep leaves min==max bonuses untouched (backwards compat)', () => {
  _resetCache();
  const db = freshDb();
  const id = makeBonus(db, { min: 5, max: 5, days: 5, current: 5, from: daysAgo(7) });
  sweepBonusRipening(db);
  const row = db.prepare('SELECT current_points, deleted_at FROM chores WHERE id = ?').get(id);
  assert.equal(row.current_points, 5);
  assert.equal(row.deleted_at, null);
});

test('sweep is cached for 60 seconds', () => {
  _resetCache();
  const db = freshDb();
  const id = makeBonus(db, { min: 1, max: 10, days: 5, current: 1, from: daysAgo(1) });
  sweepBonusRipening(db);
  // Manually rewind ripens_from again so a second sweep WOULD do something.
  db.prepare("UPDATE chores SET ripens_from = ? WHERE id = ?").run(daysAgo(1), id);
  sweepBonusRipening(db); // cached; should NOT bump again
  const row = db.prepare('SELECT current_points FROM chores WHERE id = ?').get(id);
  assert.equal(row.current_points, 3); // still from first call
});
