import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { generateForToday } from '../src/lib/assignments.js';
import { today, dayOfWeek } from '../src/lib/dates.js';

function seedKid(db, name = 'Gabriel') {
  return db.prepare(`
    INSERT INTO people (name, role) VALUES (?, 'kid') RETURNING id
  `).get(name).id;
}

function seedChore(db, fields) {
  const cols = Object.keys(fields).join(',');
  const placeholders = Object.keys(fields).map(() => '?').join(',');
  return db.prepare(`INSERT INTO chores (${cols}) VALUES (${placeholders}) RETURNING id`)
    .get(...Object.values(fields)).id;
}

test('daily recurring chore generates one assignment per assignee per day', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const chore = seedChore(db, {
    title: 'Make bed', recurs: 'daily', kind: 'recurring',
    default_assignees: String(kid),
  });
  generateForToday(db);
  const rows = db.prepare('SELECT * FROM assignments WHERE chore_id = ?').all(chore);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].person_id, kid);
  assert.equal(rows[0].due_date, today());
});

test('generator is idempotent — running twice does not duplicate', () => {
  const db = freshDb();
  const kid = seedKid(db);
  seedChore(db, { title: 'Daily X', recurs: 'daily', default_assignees: String(kid) });
  generateForToday(db);
  generateForToday(db);
  const rows = db.prepare('SELECT * FROM assignments').all();
  assert.equal(rows.length, 1);
});

test('weekly chore only generates on listed day of week', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const dow = dayOfWeek(today());
  const otherDay = (dow + 1) % 7;

  const matching = seedChore(db, {
    title: 'Today match', recurs: 'weekly', recurs_days: String(dow),
    default_assignees: String(kid),
  });
  const notMatching = seedChore(db, {
    title: 'Other day', recurs: 'weekly', recurs_days: String(otherDay),
    default_assignees: String(kid),
  });

  generateForToday(db);
  const matched = db.prepare('SELECT * FROM assignments WHERE chore_id = ?').all(matching);
  const skipped = db.prepare('SELECT * FROM assignments WHERE chore_id = ?').all(notMatching);
  assert.equal(matched.length, 1);
  assert.equal(skipped.length, 0);
});

test('soft-deleted chores are skipped', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const id = seedChore(db, { title: 'Gone', recurs: 'daily', default_assignees: String(kid) });
  db.prepare("UPDATE chores SET deleted_at = datetime('now') WHERE id = ?").run(id);
  generateForToday(db);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM assignments').get().c, 0);
});

test('chore with no default_assignees is skipped', () => {
  const db = freshDb();
  seedChore(db, { title: 'Unassigned', recurs: 'daily', default_assignees: '' });
  generateForToday(db);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM assignments').get().c, 0);
});

test('multiple default_assignees creates one assignment per kid', () => {
  const db = freshDb();
  const k1 = seedKid(db, 'Gabriel');
  const k2 = seedKid(db, 'Olivia');
  seedChore(db, { title: 'Both', recurs: 'daily', default_assignees: `${k1},${k2}` });
  generateForToday(db);
  const rows = db.prepare('SELECT * FROM assignments').all();
  assert.equal(rows.length, 2);
});
