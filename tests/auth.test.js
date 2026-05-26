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

test('migrations create chores and assignments tables', () => {
  const db = freshDb();
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'"
  ).all().map(r => r.name);
  assert.ok(tables.includes('chores'));
  assert.ok(tables.includes('assignments'));
});

test('seed migration sets default admin PIN', () => {
  const db = freshDb();
  const row = db.prepare("SELECT value FROM settings WHERE key='admin_pin_hash'").get();
  assert.ok(row, 'admin_pin_hash should exist');
  assert.ok(row.value.length > 0);
});

test('migration 004 adds weight, is_school_work, stolen_from, steal_unlock_time', () => {
  const db = freshDb();

  const choreCols = db.prepare('PRAGMA table_info(chores)').all().map(c => c.name);
  assert.ok(choreCols.includes('weight'), 'chores.weight should exist');
  assert.ok(choreCols.includes('is_school_work'), 'chores.is_school_work should exist');

  const assignmentCols = db.prepare('PRAGMA table_info(assignments)').all().map(c => c.name);
  assert.ok(assignmentCols.includes('stolen_from'), 'assignments.stolen_from should exist');

  const setting = db.prepare("SELECT value FROM settings WHERE key='steal_unlock_time'").get();
  assert.equal(setting.value, '16:00');
});
