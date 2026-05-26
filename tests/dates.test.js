import { test } from 'node:test';
import assert from 'node:assert/strict';
import { today, weekStart, isToday, isOverdue, dayOfWeek } from '../src/lib/dates.js';

test('today returns ISO date YYYY-MM-DD', () => {
  const t = today();
  assert.match(t, /^\d{4}-\d{2}-\d{2}$/);
});

test('weekStart returns the Monday ISO date for a given date', () => {
  // 2026-05-26 is a Tuesday; Monday is 2026-05-25
  assert.equal(weekStart('2026-05-26'), '2026-05-25');
  // 2026-05-25 is the Monday itself
  assert.equal(weekStart('2026-05-25'), '2026-05-25');
  // 2026-05-24 is a Sunday; Monday before is 2026-05-18
  assert.equal(weekStart('2026-05-24'), '2026-05-18');
});

test('isToday compares date to today()', () => {
  assert.equal(isToday(today()), true);
  assert.equal(isToday('2000-01-01'), false);
});

test('isOverdue is true for dates earlier than today', () => {
  assert.equal(isOverdue('2000-01-01'), true);
  assert.equal(isOverdue(today()), false);
});

test('dayOfWeek returns 0-6 (Sun-Sat)', () => {
  assert.equal(dayOfWeek('2026-05-26'), 2); // Tuesday
  assert.equal(dayOfWeek('2026-05-24'), 0); // Sunday
});
