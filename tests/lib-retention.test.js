import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb } from './helpers.js';
import { purgeOldPhotos } from '../src/lib/retention.js';

function writeFakeJpeg(root, ym, id, ageInDays) {
  const dir = join(root, ym);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${id}.jpg`);
  writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff]));
  if (ageInDays != null) {
    const now = Date.now() / 1000;
    const past = now - ageInDays * 86400;
    utimesSync(filePath, past, past);
  }
  return filePath;
}

test('purgeOldPhotos deletes .jpg files older than maxAgeDays, leaves fresh ones', () => {
  const root = mkdtempSync(join(tmpdir(), 'tally-purge-'));
  try {
    const db = freshDb();
    const oldPath = writeFakeJpeg(root, '2026-05', 1, 10);
    const recentPath = writeFakeJpeg(root, '2026-05', 2, 1);
    const result = purgeOldPhotos(db, root, 5);
    assert.equal(existsSync(oldPath), false, 'old file deleted');
    assert.equal(existsSync(recentPath), true, 'recent file kept');
    assert.equal(result.deleted, 1);
    assert.equal(result.kept, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('purgeOldPhotos deletes the assignment_photos row when its file is purged', () => {
  const root = mkdtempSync(join(tmpdir(), 'tally-purge-'));
  try {
    const db = freshDb();
    const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
    const cId = db.prepare("INSERT INTO chores (title, points, default_assignees, anti_cheat) VALUES ('X',5,?,'photo') RETURNING id").get(String(kid)).id;
    const oldPath = writeFakeJpeg(root, '2026-05', 7, 10);
    db.prepare(`
      INSERT INTO assignments (id, chore_id, person_id, due_date, status)
      VALUES (7, ?, ?, date('now', 'localtime'), 'submitted')
    `).run(cId, kid);
    db.prepare("INSERT INTO assignment_photos (assignment_id, path) VALUES (?, ?)").run(7, oldPath);

    purgeOldPhotos(db, root, 5);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM assignment_photos WHERE path = ?').get(oldPath).c, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('purgeOldPhotos handles missing uploads dir gracefully', () => {
  const db = freshDb();
  const result = purgeOldPhotos(db, '/tmp/definitely-does-not-exist-' + Date.now(), 5);
  assert.equal(result.deleted, 0);
  assert.equal(result.kept, 0);
});

test('purgeOldPhotos leaves non-jpg files alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'tally-purge-'));
  try {
    const db = freshDb();
    const dir = join(root, '2026-05');
    mkdirSync(dir, { recursive: true });
    const txt = join(dir, 'notes.txt');
    writeFileSync(txt, 'hello');
    utimesSync(txt, 100, 100); // ancient
    purgeOldPhotos(db, root, 5);
    assert.equal(existsSync(txt), true, 'non-jpg untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('purgeOldPhotos honors photo_retention_days setting (e.g. 2 days)', () => {
  const root = mkdtempSync(join(tmpdir(), 'tally-retention-'));
  try {
    const db = freshDb();
    db.prepare("INSERT INTO settings (key, value) VALUES ('photo_retention_days', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    const ym = new Date();
    const dir = join(root, `${ym.getFullYear()}-${String(ym.getMonth()+1).padStart(2,'0')}`);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, '99-1.jpg');
    writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff]));
    const threeDaysAgo = (Date.now() - 3 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(filePath, threeDaysAgo, threeDaysAgo);
    purgeOldPhotos(db, root);
    assert.equal(existsSync(filePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('purgeOldPhotos falls back to default 5 days when setting absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'tally-retention-'));
  try {
    const db = freshDb();
    const ym = new Date();
    const dir = join(root, `${ym.getFullYear()}-${String(ym.getMonth()+1).padStart(2,'0')}`);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, '88-1.jpg');
    writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff]));
    const threeDaysAgo = (Date.now() - 3 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(filePath, threeDaysAgo, threeDaysAgo);
    purgeOldPhotos(db, root);
    assert.equal(existsSync(filePath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
