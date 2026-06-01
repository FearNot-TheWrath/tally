import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInSleepWindow } from '../public/js/wall/sleep.js';

test('isInSleepWindow: simple in-window case (no midnight wrap)', () => {
  assert.equal(isInSleepWindow('13:00', '08:00', '17:00'), true);
  assert.equal(isInSleepWindow('07:59', '08:00', '17:00'), false);
  assert.equal(isInSleepWindow('17:01', '08:00', '17:00'), false);
});

test('isInSleepWindow: boundary inclusivity', () => {
  // Start is inclusive, end is exclusive — so 08:00 in, 17:00 out.
  assert.equal(isInSleepWindow('08:00', '08:00', '17:00'), true);
  assert.equal(isInSleepWindow('17:00', '08:00', '17:00'), false);
});

test('isInSleepWindow: midnight wrap', () => {
  assert.equal(isInSleepWindow('23:30', '22:00', '06:00'), true);
  assert.equal(isInSleepWindow('00:30', '22:00', '06:00'), true);
  assert.equal(isInSleepWindow('05:59', '22:00', '06:00'), true);
  assert.equal(isInSleepWindow('06:00', '22:00', '06:00'), false);
  assert.equal(isInSleepWindow('21:59', '22:00', '06:00'), false);
  assert.equal(isInSleepWindow('22:00', '22:00', '06:00'), true);
});

test('isInSleepWindow: empty window (start == end) is never sleeping', () => {
  assert.equal(isInSleepWindow('00:00', '12:00', '12:00'), false);
  assert.equal(isInSleepWindow('12:00', '12:00', '12:00'), false);
});
