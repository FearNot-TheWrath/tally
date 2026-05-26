import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';

test('migrations create people, sessions, settings tables', () => {
  const db = freshDb();
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name);
  assert.ok(tables.includes('people'));
  assert.ok(tables.includes('sessions'));
  assert.ok(tables.includes('settings'));
  assert.ok(tables.includes('_migrations'));
});
