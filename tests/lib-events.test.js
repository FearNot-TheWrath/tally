import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wallBus, notifyWall } from '../src/lib/events.js';

test('notifyWall emits refresh on wallBus', async () => {
  const refreshed = new Promise(resolve => wallBus.once('refresh', resolve));
  notifyWall();
  await Promise.race([
    refreshed,
    new Promise((_, rej) => setTimeout(() => rej(new Error('wallBus did not fire')), 500)),
  ]);
});

test('notifyWall debounces rapid calls into a single refresh', async () => {
  let count = 0;
  const handler = () => count++;
  wallBus.on('refresh', handler);

  notifyWall();
  notifyWall();
  notifyWall();

  await new Promise(r => setTimeout(r, 300));
  wallBus.off('refresh', handler);
  assert.equal(count, 1);
});

test('notifyWall fires again after debounce window passes', async () => {
  let count = 0;
  const handler = () => count++;
  wallBus.on('refresh', handler);

  notifyWall();
  await new Promise(r => setTimeout(r, 200));
  notifyWall();
  await new Promise(r => setTimeout(r, 200));

  wallBus.off('refresh', handler);
  assert.equal(count, 2);
});
