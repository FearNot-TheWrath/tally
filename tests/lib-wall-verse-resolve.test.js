import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveVerse, dayOfYear } from '../src/lib/wall/verse-resolve.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'verse-')); }
const FALLBACK = [
  { verseText: 'A', verseRef: 'Ref A' },
  { verseText: 'B', verseRef: 'Ref B' },
];

test('dayOfYear is 1 on Jan 1 and increases', () => {
  assert.equal(dayOfYear(new Date('2026-01-01T12:00:00')), 1);
  assert.equal(dayOfYear(new Date('2026-01-02T12:00:00')), 2);
});

test('resolveVerse serves the daily file when its date matches today', () => {
  const dir = tmp();
  const gen = join(dir, 'wall-verse.json');
  const fb = join(dir, 'verses-fallback.json');
  writeFileSync(gen, JSON.stringify({ date: '2026-06-01', dayName: 'Memorial', verseText: 'V', verseRef: 'R', gospelRef: 'G', source: 'daily' }));
  writeFileSync(fb, JSON.stringify(FALLBACK));
  const out = resolveVerse({ generatedPath: gen, fallbackPath: fb, todayIso: '2026-06-01' });
  assert.equal(out.source, 'daily');
  assert.equal(out.dayName, 'Memorial');
  assert.equal(out.gospelRef, 'G');
});

test('resolveVerse falls back to curated when the daily file is stale', () => {
  const dir = tmp();
  const gen = join(dir, 'wall-verse.json');
  const fb = join(dir, 'verses-fallback.json');
  writeFileSync(gen, JSON.stringify({ date: '2026-05-31', verseText: 'old', verseRef: 'old', source: 'daily' }));
  writeFileSync(fb, JSON.stringify(FALLBACK));
  const out = resolveVerse({ generatedPath: gen, fallbackPath: fb, todayIso: '2026-06-01' });
  assert.equal(out.source, 'curated');
  assert.equal(out.dayName, undefined);
  assert.equal(out.gospelRef, undefined);
  assert.ok(out.verseText);
});

test('resolveVerse falls back to curated when the daily file is missing', () => {
  const dir = tmp();
  const fb = join(dir, 'verses-fallback.json');
  writeFileSync(fb, JSON.stringify(FALLBACK));
  const out = resolveVerse({ generatedPath: join(dir, 'nope.json'), fallbackPath: fb, todayIso: '2026-06-01' });
  assert.equal(out.source, 'curated');
});

test('resolveVerse returns an empty curated verse when the fallback file is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verse-'));
  const out = resolveVerse({
    generatedPath: join(dir, 'nope-generated.json'),
    fallbackPath: join(dir, 'nope-fallback.json'),
    todayIso: '2026-06-01',
  });
  assert.equal(out.source, 'curated');
  assert.equal(out.verseText, '');
});
