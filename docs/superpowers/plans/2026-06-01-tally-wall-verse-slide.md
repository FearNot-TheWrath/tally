# Wall Verse Slide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `verse` panel to the Tally wall that shows the day's Catholic Mass Gospel Acclamation (server baked from USCCB), styled as the approved midnight navy "Slide A," with a curated NABRE verse as the offline fallback.

**Architecture:** A PM2 cron baker fetches and parses the USCCB daily readings page once a day and writes `public/generated/wall-verse.json`. A new `GET /api/wall/verse` route serves that file when fresh, otherwise a curated verse from `data/verses-fallback.json`. The wall client renders a self contained dark slide that ignores the day/night theme. Mirrors the existing `wall-radar` baker pattern. The Pi never contacts USCCB.

**Tech Stack:** Node 20 ESM, Express 5, better-sqlite3, `node:test` + supertest, vanilla JS wall client, PM2.

---

## Reconciliations with the spec (read first)

Two decisions changed during planning after reading the code. Both are intentional:

1. **Fonts use the existing Google Fonts CDN link, not self hosted woff2.** `public/wall.html` already loads Inter, JetBrains Mono, and Noto Color Emoji from the Google CDN, so the wall is not fully offline today regardless. Adding Libre Baskerville to that same `<link>` matches the established pattern. If Libre Baskerville ever fails to load (true offline), the verse degrades to a system serif, still readable. True offline font hosting for the whole wall is a separate future cleanup.
2. **Panel key is `verse`.** The settings whitelist currently contains a never built `verse-fact` key; this plan adds `verse` and leaves `verse-fact` in place harmlessly.

## File structure

```
src/lib/wall/usccb-readings.js        NEW  cleanCitation, parseReadingsHtml, usccbUrl, fetchDailyReadings
src/lib/wall/verse-resolve.js         NEW  resolveVerse() fallback chain (freshness + curated)
scripts/wall-verse.js                 NEW  daily baker -> public/generated/wall-verse.json
scripts/build-verse-fallback.js       NEW  one time builder -> data/verses-fallback.json (from docs/nabre.json)
data/verses-fallback.json             NEW  curated NABRE verses (generated artifact, committed)
tests/fixtures/usccb-2026-06-01.html  NEW  committed HTML fixture for hermetic parser test
src/routes/wall.js                    EDIT add GET /api/wall/verse; add verse_dwell_sec to /wall/config
src/routes/admin/settings.js          EDIT whitelist + validate wall_verse_dwell_sec; add 'verse' to WALL_PANEL_KEYS
src/migrations/014-wall-verse.sql     NEW  seed wall_verse_dwell_sec; migrate enabled_panels default
public/js/wall/rotation.js            EDIT per-panel dwell override
public/js/pages/wall.js               EDIT KNOWN set, renderVerse(), renderPanel() branch, dwell wiring
public/css/wall-suite.css             EDIT verse panel styles
public/wall.html                      EDIT add Libre Baskerville to the fonts link
tests/lib-wall-usccb.test.js          NEW  cleanCitation + parseReadingsHtml tests
tests/lib-wall-verse-resolve.test.js  NEW  resolveVerse freshness + fallback tests
tests/lib-wall-rotation.test.js       EDIT dwell override test
tests/routes-wall-verse.test.js       NEW  /api/wall/verse supertest
```

---

## Task 1: Citation cleanup helper

**Files:**
- Create: `src/lib/wall/usccb-readings.js`
- Test: `tests/lib-wall-usccb.test.js`

USCCB citations come as `See Revelation 1:5ab`, `Mark 12:1-12`, `Psalm 91:1-2, 14-15b`. We strip a leading `See `/`Cf. `, drop part verse letters (`a`/`b`/`c`) that trail a verse number, and collapse whitespace. Book names already arrive in full.

- [ ] **Step 1: Write the failing test**

```js
// tests/lib-wall-usccb.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCitation } from '../src/lib/wall/usccb-readings.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib-wall-usccb.test.js`
Expected: FAIL, `cleanCitation` is not exported / not a function.

- [ ] **Step 3: Write minimal implementation**

```js
// src/lib/wall/usccb-readings.js

// Normalize a USCCB citation for display: drop "See"/"Cf." prefixes and the
// a/b/c part-verse letters, collapse whitespace. Book names arrive in full.
export function cleanCitation(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim().replace(/^(see|cf\.?)\s+/i, '');
  const i = s.indexOf(':');
  if (i >= 0) {
    const head = s.slice(0, i + 1);
    const tail = s.slice(i + 1).replace(/(\d)[a-z]+/gi, '$1');
    s = head + tail;
  }
  return s.replace(/\s+/g, ' ').trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib-wall-usccb.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/wall/usccb-readings.js tests/lib-wall-usccb.test.js
git commit -m "feat(wall): cleanCitation helper for USCCB references"
```

---

## Task 2: USCCB HTML parser with committed fixture

**Files:**
- Modify: `src/lib/wall/usccb-readings.js`
- Create: `tests/fixtures/usccb-2026-06-01.html`
- Test: `tests/lib-wall-usccb.test.js`

`parseReadingsHtml(html)` returns `{ dayName, gospelRef, acclamationText, acclamationRef }`. Day name comes from the first `og:title` meta (strip a trailing `| USCCB`). Reading blocks are `<h3 class="name">LABEL</h3>` followed by `<div class="address">CITATION</div>` and `<div class="content-body">TEXT</div>`. The acclamation block label is one of `Alleluia`, `Gospel Acclamation`, `Verse Before the Gospel`. The acclamation text strips the bolded refrains (`<strong>...</strong>`), the standalone `R.` markers, and joins `<br>` as spaces.

- [ ] **Step 1: Save the committed fixture**

Run (network, one time only; the fixture is then committed so the test is hermetic):

```bash
mkdir -p tests/fixtures
curl -sL -A "Mozilla/5.0 tally-wall/1.0" \
  "https://bible.usccb.org/bible/readings/060126.cfm" \
  -o tests/fixtures/usccb-2026-06-01.html
test -s tests/fixtures/usccb-2026-06-01.html && echo "fixture saved"
```

Expected: `fixture saved`.

- [ ] **Step 2: Write the failing test**

```js
// append to tests/lib-wall-usccb.test.js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseReadingsHtml } from '../src/lib/wall/usccb-readings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(__dirname, 'fixtures/usccb-2026-06-01.html'), 'utf8');

test('parseReadingsHtml extracts the day name', () => {
  const r = parseReadingsHtml(FIXTURE);
  assert.equal(r.dayName, 'Memorial of Saint Justin, Martyr');
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/lib-wall-usccb.test.js`
Expected: FAIL, `parseReadingsHtml` is not a function.

- [ ] **Step 4: Implement the parser**

```js
// append to src/lib/wall/usccb-readings.js

const ACCLAMATION_LABELS = ['Gospel Acclamation', 'Alleluia', 'Verse Before the Gospel'];

function stripTags(html) {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Find a reading block by its <h3 class="name"> label and return the raw inner
// HTML of its .address and .content-body divs.
function blockByName(html, label) {
  const nameRe = new RegExp(`<h3 class="name">\\s*${label}\\s*</h3>`, 'i');
  const m = nameRe.exec(html);
  if (!m) return null;
  const rest = html.slice(m.index);
  const addr = /<div class="address">([\s\S]*?)<\/div>/i.exec(rest);
  const body = /<div class="content-body">([\s\S]*?)<\/div>\s*<\/div>/i.exec(rest);
  return {
    address: addr ? stripTags(addr[1]) : '',
    bodyHtml: body ? body[1] : '',
  };
}

function firstBlock(html, labels) {
  for (const label of labels) {
    const b = blockByName(html, label);
    if (b) return b;
  }
  return null;
}

// The acclamation verse is the content-body minus the bolded "Alleluia,
// alleluia." (or seasonal) refrains and the standalone "R." response markers.
function cleanAcclamationText(bodyHtml) {
  const noRefrain = bodyHtml.replace(/<strong>[\s\S]*?<\/strong>/gi, ' ');
  return stripTags(noRefrain).replace(/\bR\.\s*/g, '').replace(/\s+/g, ' ').trim();
}

export function parseReadingsHtml(html) {
  const og = /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i.exec(html);
  const dayName = og ? og[1].replace(/\s*\|\s*USCCB\s*$/i, '').trim() : '';

  const gospel = blockByName(html, 'Gospel');
  const accl = firstBlock(html, ACCLAMATION_LABELS);

  return {
    dayName,
    gospelRef: gospel ? cleanCitation(gospel.address) : '',
    acclamationRef: accl ? cleanCitation(accl.address) : '',
    acclamationText: accl ? cleanAcclamationText(accl.bodyHtml) : '',
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/lib-wall-usccb.test.js`
Expected: PASS (8 tests total).

- [ ] **Step 6: Commit**

```bash
git add src/lib/wall/usccb-readings.js tests/lib-wall-usccb.test.js tests/fixtures/usccb-2026-06-01.html
git commit -m "feat(wall): parse USCCB daily readings (day, gospel, acclamation)"
```

---

## Task 3: URL builder and fetch wrapper

**Files:**
- Modify: `src/lib/wall/usccb-readings.js`
- Test: `tests/lib-wall-usccb.test.js`

`usccbUrl(date)` builds the `MMDDYY` URL from a `Date`. `fetchDailyReadings(date)` fetches then parses (thin, exercised live by the baker, so only the URL builder is unit tested).

- [ ] **Step 1: Write the failing test**

```js
// append to tests/lib-wall-usccb.test.js
import { usccbUrl } from '../src/lib/wall/usccb-readings.js';

test('usccbUrl builds the MMDDYY readings URL', () => {
  assert.equal(
    usccbUrl(new Date('2026-06-01T12:00:00')),
    'https://bible.usccb.org/bible/readings/060126.cfm'
  );
});
test('usccbUrl zero-pads single-digit month and day', () => {
  assert.equal(
    usccbUrl(new Date('2026-01-09T12:00:00')),
    'https://bible.usccb.org/bible/readings/010926.cfm'
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib-wall-usccb.test.js`
Expected: FAIL, `usccbUrl` is not a function.

- [ ] **Step 3: Implement**

```js
// append to src/lib/wall/usccb-readings.js

export function usccbUrl(date) {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const yy = String(date.getFullYear()).slice(-2);
  return `https://bible.usccb.org/bible/readings/${mm}${dd}${yy}.cfm`;
}

export async function fetchDailyReadings(date) {
  const res = await fetch(usccbUrl(date), {
    headers: { 'User-Agent': 'Mozilla/5.0 tally-wall/1.0' },
  });
  if (!res.ok) throw new Error(`USCCB HTTP ${res.status}`);
  const html = await res.text();
  return parseReadingsHtml(html);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib-wall-usccb.test.js`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/lib/wall/usccb-readings.js tests/lib-wall-usccb.test.js
git commit -m "feat(wall): usccbUrl builder and fetchDailyReadings wrapper"
```

---

## Task 4: Verse fallback resolver

**Files:**
- Create: `src/lib/wall/verse-resolve.js`
- Test: `tests/lib-wall-verse-resolve.test.js`

`resolveVerse({ generatedPath, fallbackPath, todayIso })` returns the verse object the route serves. If the generated file exists and its `date === todayIso`, return it. Otherwise return a curated verse indexed by day of year, shaped without `dayName`/`gospelRef` so the client renders the simpler fallback layout.

- [ ] **Step 1: Write the failing test**

```js
// tests/lib-wall-verse-resolve.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib-wall-verse-resolve.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```js
// src/lib/wall/verse-resolve.js
import { readFileSync, existsSync } from 'node:fs';

export function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date - start;
  return Math.floor(diff / 86400000);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

// Returns the verse object the wall should display. Daily file wins when its
// date equals today; otherwise a curated verse indexed by day of year.
export function resolveVerse({ generatedPath, fallbackPath, todayIso, now = new Date() }) {
  if (existsSync(generatedPath)) {
    const daily = readJson(generatedPath);
    if (daily && daily.date === todayIso && daily.verseText) {
      return daily;
    }
  }
  const list = readJson(fallbackPath) || [];
  if (list.length === 0) return { verseText: '', verseRef: '', source: 'curated' };
  const pick = list[dayOfYear(now) % list.length];
  return { verseText: pick.verseText, verseRef: pick.verseRef, source: 'curated' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib-wall-verse-resolve.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/wall/verse-resolve.js tests/lib-wall-verse-resolve.test.js
git commit -m "feat(wall): resolveVerse daily-or-curated fallback chain"
```

---

## Task 5: Curated fallback builder and data file

**Files:**
- Create: `scripts/build-verse-fallback.js`
- Create (generated, committed): `data/verses-fallback.json`

A one time builder resolves a curated reference list against `docs/nabre.json` and writes `data/verses-fallback.json`. Each entry is `{ verseText, verseRef }`. Ranges (`start-end`) join verse texts with a space. The script fails loudly if any reference does not resolve, so a bad reference is caught at build time.

- [ ] **Step 1: Write the builder script**

```js
// scripts/build-verse-fallback.js
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Reference list: { book, chapter, start, end? , ref } where `ref` is the
// display string. `book` must match a book name in docs/nabre.json exactly.
const REFS = [
  { book: 'John', chapter: 3, start: 16, ref: 'John 3:16' },
  { book: 'Psalms', chapter: 23, start: 1, end: 1, ref: 'Psalm 23:1' },
  { book: 'Psalms', chapter: 46, start: 11, ref: 'Psalm 46:11' },
  { book: 'Psalms', chapter: 118, start: 24, ref: 'Psalm 118:24' },
  { book: 'Psalms', chapter: 27, start: 1, ref: 'Psalm 27:1' },
  { book: 'Psalms', chapter: 34, start: 9, ref: 'Psalm 34:9' },
  { book: 'Psalms', chapter: 100, start: 5, ref: 'Psalm 100:5' },
  { book: 'Psalms', chapter: 121, start: 2, ref: 'Psalm 121:2' },
  { book: 'Psalms', chapter: 139, start: 14, ref: 'Psalm 139:14' },
  { book: 'Proverbs', chapter: 3, start: 5, end: 6, ref: 'Proverbs 3:5-6' },
  { book: 'Isaiah', chapter: 40, start: 31, ref: 'Isaiah 40:31' },
  { book: 'Isaiah', chapter: 41, start: 10, ref: 'Isaiah 41:10' },
  { book: 'Isaiah', chapter: 43, start: 1, ref: 'Isaiah 43:1' },
  { book: 'Jeremiah', chapter: 29, start: 11, ref: 'Jeremiah 29:11' },
  { book: 'Joshua', chapter: 1, start: 9, ref: 'Joshua 1:9' },
  { book: 'Matthew', chapter: 6, start: 33, ref: 'Matthew 6:33' },
  { book: 'Matthew', chapter: 11, start: 28, ref: 'Matthew 11:28' },
  { book: 'Matthew', chapter: 5, start: 16, ref: 'Matthew 5:16' },
  { book: 'Mark', chapter: 12, start: 30, ref: 'Mark 12:30' },
  { book: 'Luke', chapter: 1, start: 37, ref: 'Luke 1:37' },
  { book: 'John', chapter: 14, start: 27, ref: 'John 14:27' },
  { book: 'John', chapter: 8, start: 12, ref: 'John 8:12' },
  { book: 'John', chapter: 15, start: 5, ref: 'John 15:5' },
  { book: 'Romans', chapter: 8, start: 28, ref: 'Romans 8:28' },
  { book: 'Romans', chapter: 12, start: 12, ref: 'Romans 12:12' },
  { book: 'Romans', chapter: 15, start: 13, ref: 'Romans 15:13' },
  { book: '1Corinthians', chapter: 13, start: 4, end: 7, ref: '1 Corinthians 13:4-7' },
  { book: '1Corinthians', chapter: 16, start: 14, ref: '1 Corinthians 16:14' },
  { book: '2Corinthians', chapter: 5, start: 7, ref: '2 Corinthians 5:7' },
  { book: 'Galatians', chapter: 5, start: 22, end: 23, ref: 'Galatians 5:22-23' },
  { book: 'Ephesians', chapter: 2, start: 10, ref: 'Ephesians 2:10' },
  { book: 'Philippians', chapter: 4, start: 6, end: 7, ref: 'Philippians 4:6-7' },
  { book: 'Philippians', chapter: 4, start: 13, ref: 'Philippians 4:13' },
  { book: 'Colossians', chapter: 3, start: 23, ref: 'Colossians 3:23' },
  { book: '1Thessalonians', chapter: 5, start: 16, end: 18, ref: '1 Thessalonians 5:16-18' },
  { book: '2Timothy', chapter: 1, start: 7, ref: '2 Timothy 1:7' },
  { book: 'Hebrews', chapter: 11, start: 1, ref: 'Hebrews 11:1' },
  { book: 'Hebrews', chapter: 13, start: 8, ref: 'Hebrews 13:8' },
  { book: 'James', chapter: 1, start: 5, ref: 'James 1:5' },
  { book: '1Peter', chapter: 5, start: 7, ref: '1 Peter 5:7' },
  { book: '1John', chapter: 4, start: 19, ref: '1 John 4:19' },
  { book: 'Micah', chapter: 6, start: 8, ref: 'Micah 6:8' },
  { book: 'Zephaniah', chapter: 3, start: 17, ref: 'Zephaniah 3:17' },
  { book: 'Lamentations', chapter: 3, start: 22, end: 23, ref: 'Lamentations 3:22-23' },
  { book: 'Deuteronomy', chapter: 31, start: 6, ref: 'Deuteronomy 31:6' },
  { book: 'Sirach', chapter: 2, start: 6, ref: 'Sirach 2:6' },
  { book: 'Wisdom', chapter: 3, start: 1, ref: 'Wisdom 3:1' },
  { book: 'Psalms', chapter: 19, start: 15, ref: 'Psalm 19:15' },
  { book: 'Psalms', chapter: 51, start: 12, ref: 'Psalm 51:12' },
  { book: 'Psalms', chapter: 145, start: 9, ref: 'Psalm 145:9' },
];

const bible = JSON.parse(readFileSync(join(ROOT, 'docs/nabre.json'), 'utf8'));
const byBook = new Map(bible.map(b => [b.book, b]));

function verseText(book, chapter, start, end) {
  const b = byBook.get(book);
  if (!b) throw new Error(`Unknown book: ${book}`);
  const ch = b.chapters.find(c => c.chapter === chapter);
  if (!ch) throw new Error(`Missing ${book} ${chapter}`);
  const hi = end || start;
  const parts = [];
  for (let v = start; v <= hi; v++) {
    const row = ch.verses.find(x => x.verse === v);
    if (!row) throw new Error(`Missing ${book} ${chapter}:${v}`);
    parts.push(row.text.trim());
  }
  return parts.join(' ');
}

const out = REFS.map(r => ({ verseText: verseText(r.book, r.chapter, r.start, r.end), verseRef: r.ref }));
mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(join(ROOT, 'data/verses-fallback.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${out.length} curated verses to data/verses-fallback.json`);
```

- [ ] **Step 2: Run the builder**

Run: `node scripts/build-verse-fallback.js`
Expected: `Wrote 50 curated verses to data/verses-fallback.json` with no thrown errors. If any reference throws (verse numbering differs in NABRE), remove or correct that entry and rerun.

- [ ] **Step 3: Spot check the output**

Run: `node -e "const a=require('./data/verses-fallback.json'); console.log(a.length, a[0])"`
Expected: count and a `{ verseText, verseRef }` object with real NABRE text.

- [ ] **Step 4: Commit**

```bash
git add scripts/build-verse-fallback.js data/verses-fallback.json
git commit -m "feat(wall): curated NABRE verse fallback set + builder"
```

---

## Task 6: Daily baker script

**Files:**
- Create: `scripts/wall-verse.js`

Fetches today's readings, builds the record, writes `public/generated/wall-verse.json` atomically. On any failure it logs and exits non-zero without overwriting the existing file (last good day preserved). No unit test (thin orchestration over already tested functions); verified by a manual run.

- [ ] **Step 1: Write the baker**

```js
// scripts/wall-verse.js
import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchDailyReadings } from '../src/lib/wall/usccb-readings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'public', 'generated');
const OUT = join(OUT_DIR, 'wall-verse.json');

function isoLocalDate(d) {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

async function main() {
  const now = new Date();
  const parsed = await fetchDailyReadings(now);
  if (!parsed.acclamationText) {
    throw new Error('no acclamation text parsed (markup change?)');
  }
  const record = {
    date: isoLocalDate(now),
    dayName: parsed.dayName,
    verseText: parsed.acclamationText,
    verseRef: parsed.acclamationRef,
    gospelRef: parsed.gospelRef,
    source: 'daily',
    fetchedAt: now.toISOString(),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const tmp = OUT + '.tmp';
  writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n');
  renameSync(tmp, OUT);
  console.log(`[wall-verse] wrote ${record.date}: ${record.verseRef}`);
}

main().catch(err => {
  console.error('[wall-verse] failed, keeping last good file:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Run the baker manually and verify output**

Run:
```bash
node scripts/wall-verse.js
cat public/generated/wall-verse.json
```
Expected: log line `[wall-verse] wrote 2026-06-01: Revelation 1:5` (date will be today), and a JSON file with `date`, `dayName`, `verseText`, `verseRef`, `gospelRef`, `source: "daily"`.

- [ ] **Step 3: Commit**

```bash
git add scripts/wall-verse.js
git commit -m "feat(wall): daily verse baker writing public/generated/wall-verse.json"
```

---

## Task 7: Per-panel dwell override in Rotation

**Files:**
- Modify: `public/js/wall/rotation.js`
- Test: `tests/lib-wall-rotation.test.js`

`nextDwellMs()` currently returns chores or other dwell only. Add an optional `dwellOverrides` map (panel key to seconds) so the verse panel can dwell 20s while other panels stay at 15s. Existing behavior with no overrides is unchanged.

- [ ] **Step 1: Write the failing test**

```js
// append to tests/lib-wall-rotation.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib-wall-rotation.test.js`
Expected: FAIL, `nextDwellMs` returns 15000 for verse (override ignored).

- [ ] **Step 3: Implement**

In `public/js/wall/rotation.js`, update the constructor and `nextDwellMs`:

```js
  constructor(enabled, { choresDwellSec = 60, otherDwellSec = 15, dwellOverrides = {} } = {}) {
    this._choresMs = choresDwellSec * 1000;
    this._otherMs  = otherDwellSec  * 1000;
    this._overrideMs = {};
    for (const [k, v] of Object.entries(dwellOverrides)) this._overrideMs[k] = v * 1000;
    this.setEnabled(enabled);
  }
```

```js
  nextDwellMs() {
    if (this._current === 'chores') return this._choresMs;
    if (this._overrideMs[this._current] != null) return this._overrideMs[this._current];
    return this._otherMs;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/lib-wall-rotation.test.js`
Expected: PASS (existing tests plus the new one).

- [ ] **Step 5: Commit**

```bash
git add public/js/wall/rotation.js tests/lib-wall-rotation.test.js
git commit -m "feat(wall): per-panel dwell override in Rotation"
```

---

## Task 8: Migration and settings

**Files:**
- Create: `src/migrations/014-wall-verse.sql`
- Modify: `src/routes/admin/settings.js`
- Test: `tests/routes-admin-settings-wall.test.js`

Add `wall_verse_dwell_sec` (default 20) and migrate the old `wall_enabled_panels` default to include `verse`. Whitelist and validate the new key, and add `verse` to the panel key set.

- [ ] **Step 1: Write the migration**

```sql
-- src/migrations/014-wall-verse.sql
INSERT INTO settings (key, value) VALUES
  ('wall_verse_dwell_sec', '20')
ON CONFLICT(key) DO NOTHING;

-- Move the never-rendered calendar/verse-fact default to the built verse panel.
UPDATE settings
   SET value = 'chores,weather,verse'
 WHERE key = 'wall_enabled_panels'
   AND value = 'chores,weather,calendar,verse-fact';
```

- [ ] **Step 2: Write the failing settings test**

```js
// append to tests/routes-admin-settings-wall.test.js
// This file already defines: freshDb, freshApp (imported) and a local
// asParent(app, db) helper. Reuse them exactly as the existing tests do.
test('PATCH wall_verse_dwell_sec accepts an int in range', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const r = await agent.patch('/api/admin/settings/wall_verse_dwell_sec').send({ value: '25' });
  assert.equal(r.status, 200);
  assert.equal(r.body.setting.value, '25');
});
test('PATCH wall_verse_dwell_sec rejects out-of-range', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const r = await agent.patch('/api/admin/settings/wall_verse_dwell_sec').send({ value: '999' });
  assert.equal(r.status, 400);
});
test('PATCH wall_enabled_panels accepts verse', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const r = await agent.patch('/api/admin/settings/wall_enabled_panels').send({ value: 'chores,weather,verse' });
  assert.equal(r.status, 200);
});
```

Then fix the existing default-assertion that migration 014 changes. In `tests/routes-wall-config.test.js`, the first test asserts the old default; update it:
```js
// was: assert.equal(c.enabled_panels, 'chores,weather,calendar,verse-fact');
assert.equal(c.enabled_panels, 'chores,weather,verse');
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/routes-admin-settings-wall.test.js`
Expected: FAIL, `wall_verse_dwell_sec` is not editable (400) and `verse` is rejected by `isValidEnabledPanels`.

- [ ] **Step 4: Implement settings changes**

In `src/routes/admin/settings.js`:

Add to `EDITABLE_KEYS`:
```js
  'wall_verse_dwell_sec',
```
Add `verse` to the panel key set:
```js
const WALL_PANEL_KEYS = new Set(['chores', 'weather', 'verse', 'calendar', 'verse-fact']);
```
Extend the dwell validator to include the new key:
```js
    if ((key === 'wall_chores_dwell_sec' || key === 'wall_other_dwell_sec' || key === 'wall_verse_dwell_sec') && !isIntInRange(value, 5, 600)) {
      return res.status(400).json({ error: `${key} must be an integer 5..600` });
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/routes-admin-settings-wall.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/migrations/014-wall-verse.sql src/routes/admin/settings.js tests/routes-admin-settings-wall.test.js
git commit -m "feat(wall): verse dwell setting + migration; allow verse panel key"
```

---

## Task 9: Verse route

**Files:**
- Modify: `src/routes/wall.js`
- Test: `tests/routes-wall-verse.test.js`

Add `GET /api/wall/verse` returning `resolveVerse(...)`, and add `verse_dwell_sec` to `GET /api/wall/config`.

- [ ] **Step 1: Write the failing test**

```js
// tests/routes-wall-verse.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';

test('GET /api/wall/verse returns a verse object', async () => {
  const db = freshDb(); const app = freshApp(db);
  const res = await request(app).get('/api/wall/verse');
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.verseText === 'string');
  assert.ok(['daily', 'curated'].includes(res.body.source));
});

test('GET /api/wall/config includes verse_dwell_sec', async () => {
  const db = freshDb(); const app = freshApp(db);
  const res = await request(app).get('/api/wall/config');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.verse_dwell_sec, 'number');
});
```

Note: this repo's tests build the app with `freshDb()` + `freshApp(db)` from `tests/helpers.js`. The verse route reads `data/verses-fallback.json` (committed in Task 5), so `/api/wall/verse` returns a curated verse in tests where no generated file exists.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/routes-wall-verse.test.js`
Expected: FAIL, 404 on `/api/wall/verse` and `verse_dwell_sec` undefined.

- [ ] **Step 3: Implement the route**

In `src/routes/wall.js`, add the import at the top:
```js
import { resolveVerse } from '../lib/wall/verse-resolve.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { today } from '../lib/dates.js';   // 'today' is already imported; do not duplicate
```
Add module constants near the top (after imports):
```js
const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSE_GENERATED = join(__dirname, '..', '..', 'public', 'generated', 'wall-verse.json');
const VERSE_FALLBACK  = join(__dirname, '..', '..', 'data', 'verses-fallback.json');
```
Add `verse_dwell_sec` to the `/wall/config` JSON response:
```js
      verse_dwell_sec:   Number(s.wall_verse_dwell_sec || 20),
```
Add the route inside `wallRoutes()`:
```js
  r.get('/wall/verse', (req, res) => {
    res.json(resolveVerse({
      generatedPath: VERSE_GENERATED,
      fallbackPath: VERSE_FALLBACK,
      todayIso: today(),
    }));
  });
```

Confirm `today()` returns a `YYYY-MM-DD` string (it is already used in this file for `todayIso`). If its format differs, pass a matching ISO date to `todayIso`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/routes-wall-verse.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/wall.js tests/routes-wall-verse.test.js
git commit -m "feat(wall): GET /api/wall/verse route + verse_dwell_sec in config"
```

---

## Task 10: Client render and wiring

**Files:**
- Modify: `public/js/pages/wall.js`

Add `verse` to the `KNOWN` set, read `verse_dwell_sec`, pass it as a dwell override, add `renderVerse()`, and branch on it in `renderPanel()`. Verified in the browser (the repo has no DOM test harness, consistent with the weather panel).

- [ ] **Step 1: Add verse to KNOWN and wire dwell in loadConfig**

In `loadConfig()`:
```js
  const KNOWN = new Set(['chores', 'weather', 'verse']);
```
After `cfg.other_dwell_sec = data.other_dwell_sec || 15;` add:
```js
  cfg.verse_dwell_sec = data.verse_dwell_sec || 20;
```
Update the `rotation` construction in `loadConfig()`:
```js
  rotation = new Rotation(cfg.enabled_panels, {
    choresDwellSec: cfg.chores_dwell_sec,
    otherDwellSec:  cfg.other_dwell_sec,
    dwellOverrides: { verse: cfg.verse_dwell_sec },
  });
```
Also add `verse_dwell_sec: 20` to the default `cfg` object near the top (where `other_dwell_sec: 15` is defined).

- [ ] **Step 2: Add renderVerse()**

Add near `renderWeather()` (uses the existing `el`, `clear`, `api`, `root` helpers; does NOT call `setDayNight`, since the slide is theme independent):
```js
async function renderVerse() {
  const data = await api.get('/api/wall/verse').catch(() => null);
  if (!data || !data.verseText) { await renderChores(); return; }

  clear(root);
  const body = [];
  if (data.dayName) body.push(el('div', { class: 'verse-eyebrow' }, [data.dayName]));
  body.push(el('div', { class: 'verse-text' }, [data.verseText]));
  body.push(el('div', { class: 'verse-rule' }, []));
  if (data.verseRef) body.push(el('div', { class: 'verse-ref' }, [data.verseRef]));

  const card = el('div', { class: 'verse-card' }, [
    el('span', { class: 'verse-corner tl' }, []),
    el('span', { class: 'verse-corner tr' }, []),
    el('span', { class: 'verse-corner bl' }, []),
    el('span', { class: 'verse-corner br' }, []),
    el('div', { class: 'verse-frame' }, []),
    el('div', { class: 'verse-body' }, body),
  ]);
  if (data.gospelRef) {
    card.appendChild(el('div', { class: 'verse-footer' }, [`Today's Gospel · ${data.gospelRef}`]));
  }
  root.appendChild(card);
}
```

- [ ] **Step 3: Branch in renderPanel()**

```js
async function renderPanel() {
  if (rotation.current() === 'weather') {
    await renderWeather();
  } else if (rotation.current() === 'verse') {
    await renderVerse();
  } else {
    await renderChores();
  }
}
```

- [ ] **Step 4: Verify in the browser**

Run the app locally (`node server.js`), open `http://localhost:3012/wall?debug`, and set `wall_enabled_panels` to `chores,weather,verse` (admin settings, or directly in the DB for the test). Expected: rotation visits the verse slide; it shows the day name, acclamation text, gold rule, reference, and the Gospel footer using today's baked `wall-verse.json`. Delete/rename the generated file and confirm it falls back to a curated verse with no eyebrow/footer.

- [ ] **Step 5: Commit**

```bash
git add public/js/pages/wall.js
git commit -m "feat(wall): render verse panel + wire dwell override and KNOWN set"
```

---

## Task 11: Verse panel styles and font

**Files:**
- Modify: `public/css/wall-suite.css`
- Modify: `public/wall.html`

Port the approved Slide A styling. The palette is hardcoded (theme independent) so the slide reads the same day and night.

- [ ] **Step 1: Add Libre Baskerville to the fonts link**

In `public/wall.html`, change the Google Fonts `<link>` (the one with `family=Inter...&family=JetBrains+Mono...`) to also request Libre Baskerville:
```html
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600;700&family=Libre+Baskerville:ital@0;1&display=swap" rel="stylesheet" />
```

- [ ] **Step 2: Add the verse panel CSS**

Append to `public/css/wall-suite.css`:
```css
/* ---- Verse panel (theme-independent dark slide) ---- */
.verse-card {
  position: absolute; inset: 0; overflow: hidden;
  background: radial-gradient(120% 90% at 50% 16%, #1a2c50 0%, #101e38 55%, #0b1528 100%);
  color: #FAF9F6; display: flex; align-items: center; justify-content: center;
}
.verse-frame { position: absolute; inset: 2.2vmin; border: 1px solid rgba(200,162,74,.28); border-radius: 8px; pointer-events: none; }
.verse-corner { position: absolute; width: 2.4vmin; height: 2.4vmin; border: 2px solid #C8A24A; }
.verse-corner.tl { top: 3vmin; left: 3vmin; border-right: 0; border-bottom: 0; }
.verse-corner.tr { top: 3vmin; right: 3vmin; border-left: 0; border-bottom: 0; }
.verse-corner.bl { bottom: 3vmin; left: 3vmin; border-right: 0; border-top: 0; }
.verse-corner.br { bottom: 3vmin; right: 3vmin; border-left: 0; border-top: 0; }
.verse-body { text-align: center; padding: 4% 11%; display: flex; flex-direction: column; align-items: center; justify-content: center; max-width: 88%; }
.verse-eyebrow { font-family: 'Inter', sans-serif; font-weight: 600; letter-spacing: .24em; text-transform: uppercase; font-size: clamp(11px, 1.6vmin, 20px); color: #D8B96E; margin-bottom: 6%; }
.verse-text { font-family: 'Libre Baskerville', Georgia, serif; font-weight: 400; letter-spacing: .2px; font-size: clamp(22px, 4.4vmin, 60px); line-height: 1.44; text-shadow: 0 2px 18px rgba(0,0,0,.35); }
.verse-rule { width: 9vmin; height: 2px; background: #C8A24A; margin: 5% auto 3.4%; border-radius: 2px; }
.verse-ref { font-family: 'Inter', sans-serif; font-weight: 600; letter-spacing: .22em; text-transform: uppercase; font-size: clamp(12px, 1.8vmin, 24px); color: #FAF9F6; }
.verse-footer { position: absolute; bottom: 7.5%; left: 0; right: 0; text-align: center; font-family: 'Inter', sans-serif; font-weight: 500; letter-spacing: .14em; text-transform: uppercase; font-size: clamp(10px, 1.4vmin, 18px); color: #E8E0D4; opacity: .62; }
```

Note: confirm the wall root element these panels render into is positioned (the weather panel relies on the same `root`). If `root` is not `position: relative`, the `.verse-card { position:absolute; inset:0 }` will not anchor; in that case render `.verse-card` as a normal block with `min-height: 100%` instead. Check how `renderWeather` fills the stage and match it.

- [ ] **Step 3: Verify in the browser**

Reload `http://localhost:3012/wall?debug`. Expected: the verse slide matches the approved Slide A (midnight navy, gold frame and corner ticks, Libre Baskerville verse, gold rule, reference, faint Gospel footer), legible and centered, with no layout shift versus the weather slide.

- [ ] **Step 4: Commit**

```bash
git add public/css/wall-suite.css public/wall.html
git commit -m "feat(wall): Slide A verse styling + Libre Baskerville font"
```

---

## Task 12: Full test run, deploy, PM2 cron, tag

**Files:** none (operations)

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: all tests pass (271 prior plus the new verse tests).

- [ ] **Step 2: Build the fallback and bake today's verse**

```bash
node scripts/build-verse-fallback.js
node scripts/wall-verse.js
cat public/generated/wall-verse.json
```
Expected: fallback rebuilt; generated file has today's date and acclamation.

- [ ] **Step 3: Restart the app and register the PM2 cron**

```bash
cd ~/projects/tally && pm2 restart tally --update-env
pm2 start scripts/wall-verse.js --name wall-verse --cron "10 0,6 * * *" --no-autorestart
pm2 save
pm2 logs wall-verse --lines 5 --nostream
```
Expected: `wall-verse` registered; logs show a successful bake. (Node is the default interpreter, so no `--interpreter` flag is needed, unlike the python `wall-radar` job.)

- [ ] **Step 4: Enable the panel and verify live**

Ensure `wall_enabled_panels` includes `verse` (migration 014 migrates the old default; if this DB had a custom value, set it via admin settings). Open `https://tally.thelopezfamily.org/wall?debug` and confirm the verse slide appears in rotation with today's acclamation and dwells ~20s.

- [ ] **Step 5: Refresh the Pi kiosk**

```bash
ssh -i ~/.ssh/hsc_pi jclopez6398@HSC-Living.local 'pkill chromium'
```
Expected: the self-healing loop relaunches Chromium and the Pi shows the new verse slide. Confirm it is legible across the room and reads well (it stays dark day and night by design).

- [ ] **Step 6: Tag the release**

```bash
git tag v0.13.0-verse
git push && git push --tags
```

---

## Self-review notes

- **Spec coverage:** Gospel Acclamation hero (Tasks 2, 6, 9, 10, 11), day name + Gospel footer (Tasks 2, 10, 11), curated fallback (Tasks 4, 5), daily baker + cron (Tasks 6, 12), citation cleanup (Task 1), route + freshness (Tasks 4, 9), rotation/dwell (Task 7), settings + migration (Task 8), styling + font (Task 11), tests throughout. All spec sections map to a task.
- **Deviations flagged:** fonts via CDN not self hosted, and panel key `verse` (both documented at the top).
- **Type consistency:** `resolveVerse({ generatedPath, fallbackPath, todayIso })` and the record shape `{ date, dayName, verseText, verseRef, gospelRef, source }` are used identically in Tasks 4, 6, and 9. `parseReadingsHtml` returns `{ dayName, gospelRef, acclamationText, acclamationRef }` consumed by the baker in Task 6. `dwellOverrides` map (seconds) used in Tasks 7 and 9.
- **Test helpers:** verified against the repo. App is built with `freshDb()` + `freshApp(db)` from `tests/helpers.js`; the settings test reuses the local `asParent(app, db)` helper. Snippets use these directly.
- **Existing test updated by migration:** Task 8 updates `tests/routes-wall-config.test.js` line 12, which asserts the old `enabled_panels` default that migration 014 rewrites to `chores,weather,verse`. This is the only existing test affected (grep confirmed).
```
