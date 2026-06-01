import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rotation } from '../public/js/wall/rotation.js';

test('Rotation with chores only never advances', () => {
  const r = new Rotation(['chores']);
  assert.equal(r.current(), 'chores');
  r.advance(() => false);
  assert.equal(r.current(), 'chores');
});

test('Rotation with chores+weather alternates chores <-> weather', () => {
  const r = new Rotation(['chores','weather']);
  assert.equal(r.current(), 'chores');
  r.advance(() => false);
  assert.equal(r.current(), 'weather');
  r.advance(() => false);
  assert.equal(r.current(), 'chores');
  r.advance(() => false);
  assert.equal(r.current(), 'weather');
});

test('Rotation cycles through others in order between chores visits', () => {
  const r = new Rotation(['chores','weather','calendar','verse-fact']);
  const visited = [];
  for (let i = 0; i < 8; i++) { visited.push(r.current()); r.advance(() => false); }
  assert.deepEqual(visited, ['chores','weather','chores','calendar','chores','verse-fact','chores','weather']);
});

test('Rotation skips a panel that reports skip=true on the same tick', () => {
  const r = new Rotation(['chores','weather','calendar','verse-fact']);
  r.advance(() => false);              // chores -> weather
  // From weather we'd next go to chores; the rotation's job is to pick "next other"
  // so let's drive forward two more hops and skip calendar when it would land.
  r.advance(() => false);              // weather -> chores
  // Next is "calendar" -- skip it.
  r.advance(p => p === 'calendar');    // chores -> calendar (skipped) -> verse-fact
  assert.equal(r.current(), 'verse-fact');
});

test('Rotation handles all-others-skip by parking on chores', () => {
  const r = new Rotation(['chores','weather','calendar']);
  // We're on chores; advance with everything-else-skip should keep us on chores.
  r.advance(p => p !== 'chores');
  assert.equal(r.current(), 'chores');
});

test('Rotation: nextDwellMs returns the appropriate dwell for current panel', () => {
  const r = new Rotation(['chores','weather'], { choresDwellSec: 60, otherDwellSec: 15 });
  assert.equal(r.nextDwellMs(), 60_000);
  r.advance(() => false);
  assert.equal(r.nextDwellMs(), 15_000);
});

test('Rotation: setEnabled swaps the panel list and resets to chores if missing', () => {
  const r = new Rotation(['chores','weather','calendar']);
  r.advance(() => false);                  // -> weather
  r.setEnabled(['chores','verse-fact']);
  assert.equal(r.current(), 'chores');
});
