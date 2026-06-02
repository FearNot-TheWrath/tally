import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cleanCitation, parseReadingsHtml, usccbUrl } from '../src/lib/wall/usccb-readings.js';

// ── Task 1: cleanCitation ──────────────────────────────────────────────────

test('cleanCitation strips leading "See" and part-verse letters', () => {
  assert.equal(cleanCitation('See Revelation 1:5ab'), 'Revelation 1:5');
});
test('cleanCitation leaves clean ranges untouched', () => {
  assert.equal(cleanCitation('Mark 12:1-12'), 'Mark 12:1-12');
});
test('cleanCitation strips letters across a multi-part psalm', () => {
  assert.equal(cleanCitation('Psalm 91:1-2, 14-15b, 15c-16'), 'Psalm 91:1-2, 14-15, 15-16');
});
test('cleanCitation strips "Cf." and trims', () => {
  assert.equal(cleanCitation('  Cf. John 6:68c '), 'John 6:68');
});

// ── Task 2: parseReadingsHtml ──────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(__dirname, 'fixtures/usccb-2026-06-01.html'), 'utf8');

test('parseReadingsHtml extracts the day name', () => {
  assert.equal(parseReadingsHtml(FIXTURE).dayName, 'Memorial of Saint Justin, Martyr');
});
test('parseReadingsHtml extracts and cleans the Gospel citation', () => {
  assert.equal(parseReadingsHtml(FIXTURE).gospelRef, 'Mark 12:1-12');
});
test('parseReadingsHtml extracts and cleans the acclamation citation', () => {
  assert.equal(parseReadingsHtml(FIXTURE).acclamationRef, 'Revelation 1:5');
});
test('parseReadingsHtml extracts clean acclamation text without refrains', () => {
  assert.equal(
    parseReadingsHtml(FIXTURE).acclamationText,
    'Jesus Christ, you are the faithful witness, the firstborn of the dead; you have loved us and freed us from our sins by your Blood.'
  );
});

// ── Task 3: usccbUrl ───────────────────────────────────────────────────────

test('usccbUrl builds the MMDDYY readings URL', () => {
  assert.equal(usccbUrl(new Date('2026-06-01T12:00:00')), 'https://bible.usccb.org/bible/readings/060126.cfm');
});
test('usccbUrl zero-pads single-digit month and day', () => {
  assert.equal(usccbUrl(new Date('2026-01-09T12:00:00')), 'https://bible.usccb.org/bible/readings/010926.cfm');
});
