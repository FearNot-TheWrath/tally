# Tally — Finish the List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up three remaining loose ends — configurable photo retention, freeze PATCH input validation, and the school-work 4 PM deadline (new chore flag + forfeit logic) — and ship them in one release.

**Architecture:** (1) `purgeOldPhotos` reads `photo_retention_days` from settings; Settings UI exposes it. (2) People PATCH rejects half-freezes with 400 before the UPDATE. (3) New `is_school_work` chore flag (independent of `unstealable`) plus a new `forfeited` flag on assignments. A lazy `sweepForfeits(db)` (called on home/wall/admin reads, mirroring `runPayoutIfDue`) stamps still-pending school work past today's `school_deadline_time` as `forfeited=1`. The submit endpoint also stamps when finishing a school chore past the cutoff. Points exclude forfeited weight from the numerator (kept in the denominator → real percentage hit). Streak `dayQualifies` fails any day with a forfeit, and the today-grace is withdrawn.

**Tech Stack:** Node 20 ESM, Express 5, better-sqlite3, vanilla JS. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-05-31-tally-finish-the-list-design.md`](../specs/2026-05-31-tally-finish-the-list-design.md)

---

## File Structure

```
~/projects/tally/
├── server.js                                       MODIFY: drop hardcoded PHOTO_RETENTION_DAYS
├── src/
│   ├── migrations/
│   │   └── 011-school-work-and-forfeit.sql         NEW
│   ├── lib/
│   │   ├── retention.js                            MODIFY: read photo_retention_days setting
│   │   ├── forfeit.js                              NEW: sweepForfeits
│   │   ├── points.js                               MODIFY: exclude forfeited from doneWeight
│   │   └── streak.js                               MODIFY: dayQualifies + currentStreak handle forfeit
│   └── routes/
│       ├── home.js                                 MODIFY: call sweepForfeits, stamp forfeited on late submit
│       ├── wall.js                                 MODIFY: call sweepForfeits
│       └── admin/
│           ├── people.js                           MODIFY: reject half-freeze PATCH
│           ├── settings.js                         MODIFY: add school_deadline_time to EDITABLE_KEYS
│           ├── today.js                            MODIFY: call sweepForfeits
│           └── chores.js                           MODIFY: add is_school_work to ALLOWED_FIELDS
├── public/js/pages/
│   ├── admin.js                                    MODIFY: photo retention input, school deadline input, school checkbox
│   └── home.js                                     MODIFY: render forfeited pill
└── tests/
    ├── lib-retention.test.js                       MODIFY: configurable retention
    ├── routes-admin-people.test.js                 MODIFY: half-freeze rejection
    ├── lib-forfeit.test.js                         NEW
    ├── routes-submit.test.js                       MODIFY: stamp forfeited on late submit
    ├── lib-points.test.js                          MODIFY: forfeited excluded from doneWeight
    ├── lib-streak.test.js                          MODIFY: forfeit fails day, breaks today
    ├── routes-admin-chores.test.js                 MODIFY: is_school_work field
    └── routes-admin-settings.test.js               MODIFY: school_deadline_time whitelisted
```

---

## Task 1: Photo retention reads setting (loose end #1)

**Files:**
- Modify: `src/lib/retention.js`
- Modify: `server.js`
- Modify: `public/js/pages/admin.js`
- Modify: `tests/lib-retention.test.js`

- [ ] **Step 1: Add a failing test to `tests/lib-retention.test.js`**

Append (use the same setup pattern as the existing tests — read the file first to match its helpers; `utimesSync` ages a file, `purgeOldPhotos` is imported):

```js
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

    purgeOldPhotos(db, root); // no maxAgeDays arg; reads from settings
    assert.equal(existsSync(filePath), false); // 2-day setting, file is 3 days old → deleted
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

    purgeOldPhotos(db, root); // no setting, default 5 days, 3-day-old file kept
    assert.equal(existsSync(filePath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

If `mkdirSync`, `writeFileSync`, `utimesSync`, `mkdtempSync`, `rmSync`, `existsSync`, `join`, `tmpdir` are not all already imported in the test file, add the missing ones. Read the existing imports first.

- [ ] **Step 2: Run to verify failure**

```bash
cd ~/projects/tally && node --test tests/lib-retention.test.js
```

Expected: FAIL — `purgeOldPhotos` ignores the setting and still uses the hardcoded default.

- [ ] **Step 3: Modify `src/lib/retention.js`**

Change the signature and read the setting at the top. Find:

```js
export function purgeOldPhotos(db, uploadsDir, maxAgeDays = 5) {
  let deleted = 0;
  let kept = 0;
  if (!existsSync(uploadsDir)) return { deleted, kept };

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
```

Replace with:

```js
export function purgeOldPhotos(db, uploadsDir, defaultDays = 5) {
  let deleted = 0;
  let kept = 0;
  if (!existsSync(uploadsDir)) return { deleted, kept };

  // Read photo_retention_days from settings; fall back to defaultDays if unset / out of range.
  let days = defaultDays;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'photo_retention_days'").get();
  if (row && row.value) {
    const parsed = parseInt(row.value, 10);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 30) days = parsed;
  }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
```

Also update the JSDoc above the function: change `@param {number} maxAgeDays files older than this get deleted` to `@param {number} defaultDays fallback when the photo_retention_days setting is unset/invalid`.

- [ ] **Step 4: Drop the hardcoded constant in `server.js`**

Find:

```js
const PHOTO_RETENTION_DAYS = 5;
```

Remove that line and all references. Change the two call sites:

```js
  const r = purgeOldPhotos(db, UPLOADS_DIR, PHOTO_RETENTION_DAYS);
```

(both occurrences — boot sweep and the daily setInterval) to:

```js
  const r = purgeOldPhotos(db, UPLOADS_DIR);
```

- [ ] **Step 5: Add the Settings UI input in `public/js/pages/admin.js`**

`renderSettings` already uses a `timeField` helper for the time inputs. Add a similar number-input pattern. Read the function to find the existing structure, then append AFTER the existing time fields (after the `payout_time` field, before the closing `}`):

```js
  const retentionField = el('div', { class: 'form-field' }, [
    el('label', {}, ['Photo retention (days)']),
    el('input', {
      type: 'number',
      min: '1',
      max: '30',
      value: s.photo_retention_days || '5',
      onChange: async (e) => {
        const v = e.target.value;
        try {
          await api.patch('/api/admin/settings/photo_retention_days', { value: String(v) });
          e.target.style.borderColor = 'var(--green)';
          setTimeout(() => { e.target.style.borderColor = ''; }, 800);
        } catch (err) { alert('Save failed: ' + err.message); }
      },
    }),
    el('div', { class: 'muted', style: { fontSize: '0.78rem', marginTop: '4px' } }, [
      'How long unreviewed photo submissions stay on disk before the daily sweep deletes them.',
    ]),
  ]);
  host.appendChild(retentionField);
```

- [ ] **Step 6: Run tests + commit**

```bash
cd ~/projects/tally && npm test 2>&1 | grep -E "# (tests|pass|fail)" && git add src/lib/retention.js server.js public/js/pages/admin.js tests/lib-retention.test.js && git commit -m "feat(retention): photo_retention_days setting wired up and exposed in Settings"
```

Expected: full suite green (~206 = 204 prior + 2 new), 0 fail.

---

## Task 2: Reject half-freeze PATCH (loose end #2)

**Files:**
- Modify: `src/routes/admin/people.js`
- Modify: `tests/routes-admin-people.test.js`

- [ ] **Step 1: Add failing tests to `tests/routes-admin-people.test.js`**

Append (mirror the existing `asParent` helper pattern in the file):

```js
test('PATCH /api/admin/people/:id rejects setting only freeze_start without freeze_end (400)', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.patch(`/api/admin/people/${kid}`).send({ freeze_start: today() });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /freeze_start.*freeze_end/i);
});

test('PATCH /api/admin/people/:id rejects setting only freeze_end without freeze_start (400)', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.patch(`/api/admin/people/${kid}`).send({ freeze_end: today() });
  assert.equal(res.status, 400);
});

test('PATCH /api/admin/people/:id rejects half-freeze with one truthy and one empty', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.patch(`/api/admin/people/${kid}`).send({ freeze_start: today(), freeze_end: '' });
  assert.equal(res.status, 400);
});

test('PATCH /api/admin/people/:id accepts both freeze bounds together', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.patch(`/api/admin/people/${kid}`).send({ freeze_start: today(), freeze_end: today() });
  assert.equal(res.status, 200);
});

test('PATCH /api/admin/people/:id accepts clearing both freeze bounds', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role, freeze_start, freeze_end) VALUES ('K','kid',?,?) RETURNING id").get(today(), today()).id;
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.patch(`/api/admin/people/${kid}`).send({ freeze_start: '', freeze_end: '' });
  assert.equal(res.status, 200);
});
```

If `today` isn't already imported at the top of the test file, add `import { today } from '../src/lib/dates.js';`.

- [ ] **Step 2: Run to verify failure**

```bash
cd ~/projects/tally && node --test tests/routes-admin-people.test.js
```

Expected: the first three new tests FAIL (today's PATCH happily accepts a half-freeze with 200).

- [ ] **Step 3: Modify `src/routes/admin/people.js`**

In the `PATCH /people/:id` handler, AFTER `const data = pickFields(req.body || {});` and BEFORE the `Object.keys(data).length === 0` check, insert the half-freeze guard:

```js
    // Half-freeze guard: when freeze fields are PATCHed, both must be present.
    const hasStart = data.freeze_start !== undefined;
    const hasEnd = data.freeze_end !== undefined;
    if (hasStart !== hasEnd) {
      return res.status(400).json({ error: 'freeze_start and freeze_end must be set together (or both blank to clear)' });
    }
    if (hasStart && hasEnd) {
      const startTruthy = !!(data.freeze_start && String(data.freeze_start).trim());
      const endTruthy = !!(data.freeze_end && String(data.freeze_end).trim());
      if (startTruthy !== endTruthy) {
        return res.status(400).json({ error: 'freeze_start and freeze_end must be set together (or both blank to clear)' });
      }
    }
```

- [ ] **Step 4: Run tests + commit**

```bash
cd ~/projects/tally && npm test 2>&1 | grep -E "# (tests|pass|fail)" && git add src/routes/admin/people.js tests/routes-admin-people.test.js && git commit -m "feat(admin/people): reject half-freeze PATCHes with 400"
```

Expected: full suite green (~211 = 206 + 5 new), 0 fail.

---

## Task 3: Migration 011 — `is_school_work` + `forfeited` columns

**Files:**
- Create: `src/migrations/011-school-work-and-forfeit.sql`

- [ ] **Step 1: Create the migration**

```sql
ALTER TABLE chores ADD COLUMN is_school_work INTEGER NOT NULL DEFAULT 0
  CHECK (is_school_work IN (0, 1));

ALTER TABLE assignments ADD COLUMN forfeited INTEGER NOT NULL DEFAULT 0
  CHECK (forfeited IN (0, 1));

CREATE INDEX idx_assignments_forfeited ON assignments(forfeited) WHERE forfeited = 1;
```

- [ ] **Step 2: Verify**

```bash
cd ~/projects/tally && node -e "import('better-sqlite3').then(async ({default:D}) => { const {runMigrations} = await import('./src/db.js'); const db = new D(':memory:'); runMigrations(db); const c = db.prepare('PRAGMA table_info(chores)').all().map(r=>r.name); const a = db.prepare('PRAGMA table_info(assignments)').all().map(r=>r.name); console.log('chores.is_school_work:', c.includes('is_school_work')); console.log('assignments.forfeited:', a.includes('forfeited')); })"
```

Expected: both `true`.

- [ ] **Step 3: Run tests + commit**

```bash
cd ~/projects/tally && npm test 2>&1 | grep -E "# (tests|pass|fail)" && git add src/migrations/011-school-work-and-forfeit.sql && git commit -m "feat(schema): migration 011 is_school_work + forfeited columns"
```

Expected: 211 pass, 0 fail (additive schema; nothing consumes it yet).

---

## Task 4: Whitelist + ALLOWED_FIELDS additions

**Files:**
- Modify: `src/routes/admin/settings.js`
- Modify: `src/routes/admin/chores.js`
- Modify: `tests/routes-admin-settings.test.js`
- Modify: `tests/routes-admin-chores.test.js`

- [ ] **Step 1: Add failing tests**

In `tests/routes-admin-settings.test.js`, append a test that PATCHing `school_deadline_time` works (matches the existing time-setting test pattern in the file — read first to match):

```js
test('PATCH /api/admin/settings/school_deadline_time succeeds (whitelisted)', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.patch('/api/admin/settings/school_deadline_time').send({ value: '17:30' });
  assert.equal(res.status, 200);
  const row = db.prepare("SELECT value FROM settings WHERE key = 'school_deadline_time'").get();
  assert.equal(row.value, '17:30');
});
```

In `tests/routes-admin-chores.test.js`, append a test that `is_school_work` round-trips (mirror the existing PATCH-round-trip pattern — read first):

```js
test('chore POST/PATCH accepts is_school_work', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const agent = await asParent(app, db);

  const c = await agent.post('/api/admin/chores').send({
    title: 'Math', weight: 4, is_school_work: 1, recurs: 'daily', anti_cheat: 'honor',
  });
  assert.equal(c.status, 200);
  assert.equal(c.body.chore.is_school_work, 1);

  const p = await agent.patch(`/api/admin/chores/${c.body.chore.id}`).send({ is_school_work: 0 });
  assert.equal(p.status, 200);
  assert.equal(p.body.chore.is_school_work, 0);
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd ~/projects/tally && npm test 2>&1 | grep -E "not ok" | head
```

Expected: both new tests fail (settings rejects unknown key; chores POST ignores the field).

- [ ] **Step 3: Modify `src/routes/admin/settings.js`**

Find the `EDITABLE_KEYS` set and add `'school_deadline_time'`:

```js
const EDITABLE_KEYS = new Set([
  'steal_unlock_time',
  'streak_warning_time',
  'late_tax_pct_default',
  'reminder_time',
  'payout_day',
  'payout_time',
  'photo_retention_days',
  'wall_theme',
  'school_deadline_time',
]);
```

- [ ] **Step 4: Modify `src/routes/admin/chores.js`**

Find the `ALLOWED_FIELDS` array and add `'is_school_work'`:

```js
const ALLOWED_FIELDS = [
  'title', 'description', 'points', 'kind',
  'recurs', 'recurs_days', 'recurs_anchor', 'due_time',
  'anti_cheat', 'late_tax_pct', 'photo_prompt', 'default_assignees',
  'weight', 'unstealable', 'is_school_work',
];
```

- [ ] **Step 5: Run tests + commit**

```bash
cd ~/projects/tally && npm test 2>&1 | grep -E "# (tests|pass|fail)" && git add src/routes/admin/settings.js src/routes/admin/chores.js tests/routes-admin-settings.test.js tests/routes-admin-chores.test.js && git commit -m "feat(admin): whitelist school_deadline_time + is_school_work field"
```

Expected: ~213 (211 + 2 new), 0 fail.

---

## Task 5: `src/lib/forfeit.js` — sweepForfeits + tests

**Files:**
- Create: `src/lib/forfeit.js`
- Create: `tests/lib-forfeit.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/lib-forfeit.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { sweepForfeits, _resetCache } from '../src/lib/forfeit.js';
import { today, toIso } from '../src/lib/dates.js';

function seedKid(db) {
  return db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
}
function seedSchoolChore(db, isSchool = 1) {
  return db.prepare(
    "INSERT INTO chores (title, weight, recurs, default_assignees, is_school_work) VALUES ('Math',3,'daily','',?) RETURNING id"
  ).get(isSchool).id;
}
function seedAssignment(db, choreId, kidId, dueDate, status = 'pending') {
  return db.prepare(
    "INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, ?) RETURNING id"
  ).get(choreId, kidId, dueDate, status).id;
}
function daysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n); return toIso(d);
}
function setDeadline(db, hhmm) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('school_deadline_time', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(hhmm);
}

test('sweepForfeits flips pending school chore on today past the deadline', () => {
  _resetCache();
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedSchoolChore(db, 1);
  const aId = seedAssignment(db, c, kid, today(), 'pending');
  setDeadline(db, '00:00'); // any moment "now" is past deadline
  sweepForfeits(db);
  const row = db.prepare('SELECT forfeited FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.forfeited, 1);
});

test('sweepForfeits does NOT touch non-school chores', () => {
  _resetCache();
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedSchoolChore(db, 0); // not school work
  const aId = seedAssignment(db, c, kid, today(), 'pending');
  setDeadline(db, '00:00');
  sweepForfeits(db);
  const row = db.prepare('SELECT forfeited FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.forfeited, 0);
});

test('sweepForfeits does NOT touch done chores', () => {
  _resetCache();
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedSchoolChore(db, 1);
  const aId = seedAssignment(db, c, kid, today(), 'done');
  setDeadline(db, '00:00');
  sweepForfeits(db);
  const row = db.prepare('SELECT forfeited FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.forfeited, 0);
});

test('sweepForfeits flips pending school chore from a past day', () => {
  _resetCache();
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedSchoolChore(db, 1);
  const aId = seedAssignment(db, c, kid, daysAgo(1), 'pending');
  setDeadline(db, '00:00');
  sweepForfeits(db);
  const row = db.prepare('SELECT forfeited FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.forfeited, 1);
});

test('sweepForfeits does NOT flip today when before the deadline', () => {
  _resetCache();
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedSchoolChore(db, 1);
  const aId = seedAssignment(db, c, kid, today(), 'pending');
  setDeadline(db, '23:59'); // not past deadline yet (unless run at 23:59+)
  sweepForfeits(db);
  const row = db.prepare('SELECT forfeited FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.forfeited, 0);
});

test('sweepForfeits is idempotent (running twice does nothing extra)', () => {
  _resetCache();
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedSchoolChore(db, 1);
  const aId = seedAssignment(db, c, kid, today(), 'pending');
  setDeadline(db, '00:00');
  sweepForfeits(db);
  _resetCache();
  sweepForfeits(db);
  const row = db.prepare('SELECT forfeited FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.forfeited, 1);
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd ~/projects/tally && node --test tests/lib-forfeit.test.js
```

Expected: FAIL — `src/lib/forfeit.js` doesn't exist.

- [ ] **Step 3: Create `src/lib/forfeit.js`**

```js
import { today } from './dates.js';

let lastCheck = 0;

export function _resetCache() {
  lastCheck = 0;
}

export function sweepForfeits(db) {
  const now = Date.now();
  if (now - lastCheck < 60_000) return;
  lastCheck = now;

  const row = db.prepare("SELECT value FROM settings WHERE key = 'school_deadline_time'").get();
  const deadline = (row && row.value) ? row.value : '16:00';
  const [hh, mm] = deadline.split(':').map(Number);

  const t = today();
  const nowDate = new Date();
  const cutoff = new Date();
  cutoff.setHours(hh, mm, 0, 0);
  const pastTodaysCutoff = nowDate >= cutoff;

  // Flip forfeited=1 on school-work assignments whose deadline has passed and
  // that are not yet done. Past days are always past their deadline; today
  // qualifies only after the cutoff time.
  if (pastTodaysCutoff) {
    db.prepare(`
      UPDATE assignments
      SET forfeited = 1, updated_at = datetime('now')
      WHERE forfeited = 0
        AND status != 'done'
        AND due_date <= ?
        AND chore_id IN (SELECT id FROM chores WHERE is_school_work = 1)
    `).run(t);
  } else {
    db.prepare(`
      UPDATE assignments
      SET forfeited = 1, updated_at = datetime('now')
      WHERE forfeited = 0
        AND status != 'done'
        AND due_date < ?
        AND chore_id IN (SELECT id FROM chores WHERE is_school_work = 1)
    `).run(t);
  }
}
```

- [ ] **Step 4: Run tests + commit**

```bash
cd ~/projects/tally && node --test tests/lib-forfeit.test.js && npm test 2>&1 | grep -E "# (tests|pass|fail)" && git add src/lib/forfeit.js tests/lib-forfeit.test.js && git commit -m "feat(forfeit): sweepForfeits stamps school-work past deadline"
```

Expected: forfeit tests pass; full suite ~219 (213 + 6 new), 0 fail.

---

## Task 6: Wire `sweepForfeits` into read routes

**Files:**
- Modify: `src/routes/home.js`
- Modify: `src/routes/wall.js`
- Modify: `src/routes/admin/today.js`

- [ ] **Step 1: Add import + call to each route**

In each of those three files, add `import { sweepForfeits } from '../lib/forfeit.js';` (or `'../../lib/forfeit.js'` for `admin/today.js`) alongside the existing `runPayoutIfDue` import.

Then in each route handler, add `sweepForfeits(db);` immediately after the existing `runPayoutIfDue(db);` line.

(For `admin/today.js` the import path is `'../../lib/forfeit.js'`.)

- [ ] **Step 2: Run tests + commit**

```bash
cd ~/projects/tally && npm test 2>&1 | grep -E "# (tests|pass|fail)" && git add src/routes/home.js src/routes/wall.js src/routes/admin/today.js && git commit -m "feat(routes): call sweepForfeits on home, wall, admin/today reads"
```

Expected: 219 pass, 0 fail (no new tests; behavior is additive and idempotent).

---

## Task 7: `doSubmit` stamps forfeited when finishing school work past deadline

**Files:**
- Modify: `src/routes/home.js`
- Modify: `tests/routes-submit.test.js`

- [ ] **Step 1: Add a failing test**

Append to `tests/routes-submit.test.js`:

```js
test('submit on a school-work honor chore past the deadline sets forfeited=1', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const c = db.prepare("INSERT INTO chores (title, points, recurs, default_assignees, anti_cheat, is_school_work) VALUES ('Math', 5, 'daily', ?, 'honor', 1) RETURNING id").get(String(kid)).id;
  const aId = db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now','localtime'), 'pending') RETURNING id").get(c, kid).id;
  db.prepare("INSERT INTO settings (key, value) VALUES ('school_deadline_time', '00:00') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  const app = freshApp(db);
  const agent = await loginKid(app, kid);
  const res = await agent.post(`/api/assignments/${aId}/submit`);
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT status, forfeited FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'done');
  assert.equal(row.forfeited, 1);
});

test('submit on a school-work honor chore BEFORE deadline keeps forfeited=0', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const c = db.prepare("INSERT INTO chores (title, points, recurs, default_assignees, anti_cheat, is_school_work) VALUES ('Math', 5, 'daily', ?, 'honor', 1) RETURNING id").get(String(kid)).id;
  const aId = db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now','localtime'), 'pending') RETURNING id").get(c, kid).id;
  db.prepare("INSERT INTO settings (key, value) VALUES ('school_deadline_time', '23:59') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  const app = freshApp(db);
  const agent = await loginKid(app, kid);
  const res = await agent.post(`/api/assignments/${aId}/submit`);
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT forfeited FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.forfeited, 0);
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd ~/projects/tally && node --test tests/routes-submit.test.js
```

Expected: the new "past deadline" test FAILS (forfeited still 0).

- [ ] **Step 3: Modify `src/routes/home.js`**

Inside the `doSubmit` function, change the chore lookup to also fetch `is_school_work`, and add a helper that decides "are we past today's school deadline AND is this a school-work chore due today?" Then in EACH of the three branches (honor done, approval submitted, photo submitted via the `.then`) where status changes, set `forfeited = 1` when the predicate is true.

Find:

```js
  const chore = db.prepare('SELECT anti_cheat, points FROM chores WHERE id = ?').get(a.chore_id);
```

Change to:

```js
  const chore = db.prepare('SELECT anti_cheat, points, is_school_work FROM chores WHERE id = ?').get(a.chore_id);
```

Right after that, add a helper expression:

```js
  // Forfeited stamping when finishing school work past today's deadline.
  const settingRow = db.prepare("SELECT value FROM settings WHERE key = 'school_deadline_time'").get();
  const deadline = (settingRow && settingRow.value) ? settingRow.value : '16:00';
  const [_h, _m] = deadline.split(':').map(Number);
  const _cutoff = new Date();
  _cutoff.setHours(_h, _m, 0, 0);
  const _past = new Date() >= _cutoff;
  const _isToday = a.due_date === today();
  const forfeitOnDone = (chore.is_school_work === 1 && _isToday && _past) ? 1 : 0;
```

Then in the **honor done** UPDATE, find:

```js
    db.prepare(`
      UPDATE assignments
      SET status = 'done',
          updated_at = datetime('now'),
          late = CASE WHEN due_date < date('now') THEN 1 ELSE 0 END,
          points_earned = ?
      WHERE id = ?
    `).run(chore.points, req.params.id);
```

Change to:

```js
    db.prepare(`
      UPDATE assignments
      SET status = 'done',
          updated_at = datetime('now'),
          late = CASE WHEN due_date < date('now') THEN 1 ELSE 0 END,
          points_earned = ?,
          forfeited = CASE WHEN ? = 1 THEN 1 ELSE forfeited END
      WHERE id = ?
    `).run(chore.points, forfeitOnDone, req.params.id);
```

In the **approval submitted** UPDATE, find:

```js
    db.prepare(`
      UPDATE assignments
      SET status = 'submitted', submitted_at = datetime('now'),
          note = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(req.body?.note || '', req.params.id);
```

Change to:

```js
    db.prepare(`
      UPDATE assignments
      SET status = 'submitted', submitted_at = datetime('now'),
          note = ?, updated_at = datetime('now'),
          forfeited = CASE WHEN ? = 1 THEN 1 ELSE forfeited END
      WHERE id = ?
    `).run(req.body?.note || '', forfeitOnDone, req.params.id);
```

In the **photo submitted** `.then` block, find the existing UPDATE (it's the one without `photo_path =` since that was retired). It looks roughly like:

```js
      db.prepare(`
        UPDATE assignments
        SET status = 'submitted', submitted_at = datetime('now'),
            note = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(req.body?.note || '', req.params.id);
```

Change to:

```js
      db.prepare(`
        UPDATE assignments
        SET status = 'submitted', submitted_at = datetime('now'),
            note = ?, updated_at = datetime('now'),
            forfeited = CASE WHEN ? = 1 THEN 1 ELSE forfeited END
        WHERE id = ?
      `).run(req.body?.note || '', forfeitOnDone, req.params.id);
```

Read the file first to confirm the exact current text in each branch (it has evolved through prior phases) and match it.

- [ ] **Step 4: Run tests + commit**

```bash
cd ~/projects/tally && npm test 2>&1 | grep -E "# (tests|pass|fail)" && git add src/routes/home.js tests/routes-submit.test.js && git commit -m "feat(submit): stamp forfeited=1 when finishing school work past the deadline"
```

Expected: ~221 (219 + 2 new), 0 fail.

---

## Task 8: Points + streak honor `forfeited`

**Files:**
- Modify: `src/lib/points.js`
- Modify: `src/lib/streak.js`
- Modify: `tests/lib-points.test.js`
- Modify: `tests/lib-streak.test.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/lib-points.test.js`:

```js
test('calcWeekPoints: a forfeited done chore contributes 0 to doneWeight but stays in totalWeight', () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role, weekly_target_pts) VALUES ('K','kid',100) RETURNING id").get().id;
  const c1 = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('A',3,'none','') RETURNING id").get().id;
  const c2 = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('B',3,'none','') RETURNING id").get().id;
  const ws = weekStart(today());
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, 'done')").run(c1, kid, today());
  // Forfeited but done (kid finished it late)
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status, forfeited) VALUES (?, ?, ?, 'done', 1)").run(c2, kid, today());

  const r = calcWeekPoints(db, kid, ws);
  // doneWeight only counts c1 (3), totalWeight counts both (6) → 50%
  assert.equal(r.totalWeight, 6);
  assert.equal(r.doneWeight, 3);
  assert.equal(r.weightedPercent, 0.5);
});
```

Append to `tests/lib-streak.test.js` (matching its existing helpers):

```js
test('currentStreak: a day with any forfeited row fails the day (streak breaks)', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  // 2 days ago: done — last qualifying day
  seedAssignment(db, c, kid, daysAgo(2), 'done');
  // 1 day ago: a forfeited row → day fails even if also done
  const c2 = seedChore(db);
  seedAssignment(db, c2, kid, daysAgo(1), 'done');
  db.prepare("UPDATE assignments SET forfeited = 1 WHERE chore_id = ? AND person_id = ? AND due_date = ?").run(c2, kid, daysAgo(1));
  // today: done
  seedAssignment(db, c, kid, today(), 'done');
  // Walking back: today → 1, yesterday fails (forfeit) → break. Streak = 1.
  assert.equal(currentStreak(db, kid), 1);
});

test('currentStreak: today with a forfeit breaks immediately (no in-progress grace)', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  // yesterday: done
  seedAssignment(db, c, kid, daysAgo(1), 'done');
  // today: forfeited (still pending or done with forfeit=1) — breaks immediately
  const c2 = seedChore(db);
  const aId = seedAssignment(db, c2, kid, today(), 'pending');
  db.prepare("UPDATE assignments SET forfeited = 1 WHERE id = ?").run(aId);
  // Today should break immediately; result = 0
  assert.equal(currentStreak(db, kid), 0);
});
```

- [ ] **Step 2: Run to verify failures**

```bash
cd ~/projects/tally && node --test tests/lib-points.test.js tests/lib-streak.test.js
```

Expected: the three new tests FAIL.

- [ ] **Step 3: Modify `src/lib/points.js`**

In `calcWeekPoints`, the `doneWeight` query selects done assignments. Add `AND a.forfeited = 0` so forfeited done chores contribute zero. Find:

```js
  const doneRow = db.prepare(`
    SELECT COALESCE(SUM(c.weight), 0) AS w
    FROM assignments a
    JOIN chores c ON c.id = a.chore_id
    WHERE a.due_date BETWEEN ? AND date(?, '+6 days')
      AND a.person_id = ?
      AND a.status = 'done'
      AND c.kind != 'bonus'
  `).get(weekStartIso, weekStartIso, personId);
```

Change to:

```js
  const doneRow = db.prepare(`
    SELECT COALESCE(SUM(c.weight), 0) AS w
    FROM assignments a
    JOIN chores c ON c.id = a.chore_id
    WHERE a.due_date BETWEEN ? AND date(?, '+6 days')
      AND a.person_id = ?
      AND a.status = 'done'
      AND a.forfeited = 0
      AND c.kind != 'bonus'
  `).get(weekStartIso, weekStartIso, personId);
```

The `matRows` denominator query is unchanged (forfeited chores stay in the denominator → real percentage hit).

- [ ] **Step 4: Modify `src/lib/streak.js`**

In `dayQualifies(db, personId, dateIso)`, after fetching the count/done counts, check for forfeit and fail the day. Find the function body and the closing return statement; add a forfeit check before the existing return:

```js
function dayQualifies(db, personId, dateIso) {
  // Currently uses count(*) vs sum(status='done')-style logic.
  // (Match the existing function exactly; only adding the forfeit check.)
  ...
}
```

Locate the function in the file. Right before its final `return ...;`, insert:

```js
  const fCount = db.prepare(`
    SELECT COUNT(*) AS n
    FROM assignments
    WHERE person_id = ? AND due_date = ? AND forfeited = 1
  `).get(personId, dateIso).n;
  if (fCount > 0) return false;
```

In `currentStreak(db, personId)`, find the loop where today is handled. The existing logic walks back and on today, if `!dayQualifies(today)`, it currently SKIPS today (the in-progress grace) and continues. Add: if today has any forfeit, do NOT skip — break immediately. After the line that computes `dayQualifies(...)` for today (or near where the today branch is handled), add a check that fetches forfeit count for today and breaks if positive. Read the current `currentStreak` to identify the exact insertion point — the rule is "today qualifies normally → count; today fails AND has forfeit → break (do not skip); today fails with no forfeit → skip (in-progress)".

A minimal change: add a helper `hasForfeitToday(db, personId)` and modify the today-fail branch to break when it returns true. Read the function to find its structure (it likely uses a `while` loop and a `dateIso === today()` check).

- [ ] **Step 5: Run tests + commit**

```bash
cd ~/projects/tally && node --test tests/lib-points.test.js tests/lib-streak.test.js && npm test 2>&1 | grep -E "# (tests|pass|fail)" && git add src/lib/points.js src/lib/streak.js tests/lib-points.test.js tests/lib-streak.test.js && git commit -m "feat(points+streak): forfeited chores zero-out numerator and break the day's streak"
```

Expected: ~224 (221 + 3 new), 0 fail.

---

## Task 9: Admin UI — school checkbox + deadline input

**Files:**
- Modify: `public/js/pages/admin.js`

- [ ] **Step 1: Add the school-work checkbox in the chore modal**

Find `editChore` and its existing `unstealable` checkbox. Add a new checkbox immediately after it, bound to `data.is_school_work`. Pattern:

```js
    el('div', { class: 'form-field' }, [
      el('label', { class: 'row', style: { gap: '6px', cursor: 'pointer' } }, [
        el('input', {
          type: 'checkbox',
          checked: data.is_school_work === 1,
          onChange: e => { data.is_school_work = e.target.checked ? 1 : 0; },
        }),
        el('span', {}, ['School work: has a daily deadline']),
      ]),
    ]),
```

Also update the new-chore default object in `editChore` to include `is_school_work: 0` alongside the existing `unstealable: 0`.

- [ ] **Step 2: Add the school deadline time input in renderSettings**

After the existing `streak_warning_time` input (use the `timeField` helper already in the file), add:

```js
  host.appendChild(timeField(
    'school_deadline_time', '16:00',
    'School deadline (24-hour local)',
    'School-work chores not done by this time forfeit their points and break the streak (still must be completed).',
  ));
```

- [ ] **Step 3: Run tests + commit**

```bash
cd ~/projects/tally && node --check public/js/pages/admin.js && npm test 2>&1 | grep -E "# (tests|pass|fail)" && git add public/js/pages/admin.js && git commit -m "feat(admin): school-work checkbox in chore modal + school deadline setting"
```

Expected: parses; 224 pass, 0 fail.

---

## Task 10: Kid home — render forfeited indicator

**Files:**
- Modify: `public/js/pages/home.js`
- Modify: `public/css/layouts.css`

- [ ] **Step 1: Update `renderTask` in `public/js/pages/home.js`**

Read the function. The assignment objects already include `forfeited` (it's in `SELECT * FROM assignments` essentially — confirm the home route SELECT includes `a.forfeited`; if not, add it). Add a class flag and a small red pill.

In the classes-building block at the top of `renderTask`, after the excused branch, add:

```js
  if (a.forfeited === 1) classes.push('forfeited');
```

In the title-row contents inside the returned `el(...)` (the block that includes `stolenBadge`, `bonusBadge`, etc.), add the missed-deadline pill:

```js
  a.forfeited === 1
    ? el('span', { class: 'pill pill-danger', style: { fontSize: '0.62rem', marginLeft: '6px' } }, ['Missed deadline · no points'])
    : null,
```

If the home route SELECT in `src/routes/home.js` does NOT include `a.forfeited`, add it: in the assignments query inside the `GET /home` handler, the SELECT clause needs `a.forfeited` added alongside the other `a.*` columns. Read the route first to confirm.

- [ ] **Step 2: Append CSS to `public/css/layouts.css`**

```css
.txn.forfeited { opacity: 0.7; }
.txn.forfeited .ico { background: #FEE2E2; color: var(--red); }
```

- [ ] **Step 3: Run tests + commit**

```bash
cd ~/projects/tally && node --check public/js/pages/home.js && npm test 2>&1 | grep -E "# (tests|pass|fail)" && git add public/js/pages/home.js public/css/layouts.css src/routes/home.js && git commit -m "feat(home): render Missed deadline pill on forfeited chores"
```

(Include `src/routes/home.js` in the commit only if you needed to add `a.forfeited` to its SELECT.)

Expected: parses; 224 pass, 0 fail.

---

## Task 11: Deploy + tag + push

- [ ] **Step 1: Final suite**

```bash
cd ~/projects/tally && npm test 2>&1 | grep -E "# (tests|pass|fail)"
```

Expected: ~224 pass, 0 fail.

- [ ] **Step 2: Back up DB, reload PM2, verify**

```bash
cd ~/projects/tally && cp tally.db "tally.db.bak-pre-finish-list-$(date +%Y%m%d-%H%M%S)" && pm2 reload tally 2>&1 | tail -1 && sleep 3 && curl -sf http://localhost:3012/api/health && echo " <- health"
```

Expected: `{"ok":true}`.

- [ ] **Step 3: Verify migrations applied in production**

```bash
cd ~/projects/tally && node -e "import('better-sqlite3').then(({default:D}) => { const db = new D('./tally.db'); const m = db.prepare('SELECT name FROM _migrations ORDER BY name').all().map(r=>r.name); console.log('011 applied:', m.includes('011-school-work-and-forfeit.sql')); const c = db.prepare('PRAGMA table_info(chores)').all().map(r=>r.name); const a = db.prepare('PRAGMA table_info(assignments)').all().map(r=>r.name); console.log('chores.is_school_work live:', c.includes('is_school_work')); console.log('assignments.forfeited live:', a.includes('forfeited')); })"
```

Expected: all three `true`.

- [ ] **Step 4: Tag and push**

```bash
cd ~/projects/tally && git tag v0.11.0-finish-the-list && git push origin master && git push origin v0.11.0-finish-the-list 2>&1 | tail -3
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task(s) |
|---|---|
| §4 Configurable photo retention | Task 1 |
| §5 Freeze PATCH validation | Task 2 |
| §6 Schema (migration 011) | Task 3 |
| §6 school_deadline_time + is_school_work whitelist | Task 4 |
| §6 sweepForfeits module + tests | Task 5 |
| §6 Lazy wire into home/wall/admin-today | Task 6 |
| §6 doSubmit forfeit stamping | Task 7 |
| §6 Points math change | Task 8 |
| §6 Streak math change | Task 8 |
| §6 Admin UI (chore modal + settings) | Task 9 |
| §6 Kid home UI forfeited pill | Task 10 |
| §9 Acceptance | Task 11 + manual |

**Placeholder scan:** Each task step has concrete code or commands. Task 8 step 4 references "read the function to identify the exact insertion point" for the `currentStreak` change because that function's structure depends on prior phases — the implementer reads it before editing, which is the right approach for a careful surgical edit.

**Type/identifier consistency:**
- `forfeited` (column name) used identically in migration (Task 3), sweep (Task 5), submit (Task 7), points (Task 8), streak (Task 8), home payload + UI (Task 10).
- `is_school_work` consistent across migration (Task 3), `ALLOWED_FIELDS` (Task 4), sweep query (Task 5), submit lookup (Task 7), admin modal (Task 9).
- `school_deadline_time` setting consistent across whitelist (Task 4), sweep (Task 5), submit (Task 7), Settings UI (Task 9).
- `sweepForfeits(db)` signature consistent in module (Task 5) and three callers (Task 6).
- `_resetCache()` exported for test isolation in Task 5.

Plan is internally consistent.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-31-tally-finish-the-list.md`. 11 tasks. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, verification between
**2. Inline** — direct in this session

Which approach?
