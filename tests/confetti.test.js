import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMilestone } from '../public/js/lib/confetti.js';

test('isMilestone returns true for 7-day milestone', () => {
  assert.equal(isMilestone(7), true);
});

test('isMilestone returns true for 14-day milestone', () => {
  assert.equal(isMilestone(14), true);
});

test('isMilestone returns true for 30-day milestone', () => {
  assert.equal(isMilestone(30), true);
});

test('isMilestone returns true for 60-day milestone', () => {
  assert.equal(isMilestone(60), true);
});

test('isMilestone returns true for 100-day milestone', () => {
  assert.equal(isMilestone(100), true);
});

test('isMilestone returns true for multiples of 100 above 100', () => {
  assert.equal(isMilestone(200), true);
  assert.equal(isMilestone(300), true);
});

test('isMilestone returns false for non-milestone days', () => {
  assert.equal(isMilestone(1), false);
  assert.equal(isMilestone(5), false);
  assert.equal(isMilestone(15), false);
  assert.equal(isMilestone(50), false);
  assert.equal(isMilestone(150), false);
});
