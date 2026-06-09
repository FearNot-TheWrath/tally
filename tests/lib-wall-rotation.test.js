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

test('nextDwellMs honors a per-panel dwell override', () => {
  const r = new Rotation(['chores', 'weather', 'verse'], {
    choresDwellSec: 60, otherDwellSec: 15, dwellOverrides: { verse: 20 },
  });
  // advance to first other (weather): no override -> 15s
  r.advance(() => false);
  assert.equal(r.current(), 'weather');
  assert.equal(r.nextDwellMs(), 15000);
  // back to chores, then to verse: override -> 20s
  r.advance(() => false);
  r.advance(() => false);
  assert.equal(r.current(), 'verse');
  assert.equal(r.nextDwellMs(), 20000);
});

test('Rotation: setEnabled swaps the panel list and resets to chores if missing', () => {
  const r = new Rotation(['chores','weather','calendar']);
  r.advance(() => false);                  // -> weather
  r.setEnabled(['chores','verse-fact']);
  assert.equal(r.current(), 'chores');
});

test('Rotation honors per-panel dwellByPanel for nextDwellMs', () => {
  const r = new Rotation(['chores', 'weather', 'calendar'], {
    dwellByPanel: { chores: 50, weather: 25, calendar: 12 },
    smartCycle: true,
  });
  assert.equal(r.nextDwellMs(), 50_000);     // on chores
  r.advance(() => false);                    // -> weather
  assert.equal(r.nextDwellMs(), 25_000);
  r.advance(() => false);                    // -> chores (smart cycle)
  assert.equal(r.nextDwellMs(), 50_000);
  r.advance(() => false);                    // -> calendar (smart cycle)
  assert.equal(r.nextDwellMs(), 12_000);
});

test('Rotation with smartCycle off walks panels in declared order', () => {
  const r = new Rotation(['chores', 'weather', 'calendar', 'verse-fact'], {
    dwellByPanel: { chores: 10, weather: 10, calendar: 10, 'verse-fact': 10 },
    smartCycle: false,
  });
  const visited = [];
  for (let i = 0; i < 8; i++) { visited.push(r.current()); r.advance(() => false); }
  assert.deepEqual(visited, [
    'chores', 'weather', 'calendar', 'verse-fact',
    'chores', 'weather', 'calendar', 'verse-fact',
  ]);
});

test('Rotation: missing dwell entry falls back to 15s default', () => {
  const r = new Rotation(['chores', 'weather'], {
    dwellByPanel: { chores: 60 },
    smartCycle: true,
  });
  r.advance(() => false);  // -> weather
  assert.equal(r.nextDwellMs(), 15_000);
});

test('Rotation: legacy constructor options still work (choresDwellSec/otherDwellSec)', () => {
  const r = new Rotation(['chores', 'weather'], {
    choresDwellSec: 60,
    otherDwellSec:  20,
  });
  assert.equal(r.nextDwellMs(), 60_000);
  r.advance(() => false);
  assert.equal(r.nextDwellMs(), 20_000);
});
