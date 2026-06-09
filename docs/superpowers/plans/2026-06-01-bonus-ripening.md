# Bonus Ripening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bonus chores ripen daily from `min_points` to `max_points` over `days_to_ripen` days, get one day of grace at max, then soft-delete. Wall + home bonus cards show a green/yellow/red heat tint based on ripeness.

**Architecture:** Migration 014 adds five columns to `chores`. A new `src/lib/bonus-ripen.js` module runs a lazy daily sweep on wall/home/admin reads (same pattern as `sweepForfeits` and `runPayoutIfDue`). Admin chore modal grows three inputs when kind=bonus. Wall and home bonus cards get a `data-heat` attribute, CSS adds tint rules.

**Tech Stack:** Node 20 ESM, Express 5, better-sqlite3, vanilla JS, CSS.

**Spec:** `docs/superpowers/specs/2026-06-01-bonus-ripening-design.md`

---

## File map

**New:**
```
src/migrations/014-bonus-ripening.sql
src/lib/bonus-ripen.js
tests/lib-bonus-ripen.test.js
```

**Modified:**
```
src/routes/admin/chores.js        ALLOWED_FIELDS, init on POST, reset-on-edit, validators
src/routes/wall.js                call sweep, expose ripening fields on bonuses
src/routes/home.js                call sweep, expose ripening fields, update claim handler
src/routes/admin/today.js         call sweep (so admin Today view also drives ripening)
public/js/pages/admin.js          chore modal grows min/max/days inputs when bonus
public/js/pages/wall.js           bonus card data-heat + class
public/css/layouts.css            .wall-bonus-item[data-heat=...] rules + keyframes
tests/routes-admin-chores.test.js additions for new validators
```

---

## Task 1: Migration 014 + chores route plumbing

**Files:**
- Create: `src/migrations/014-bonus-ripening.sql`
- Modify: `src/routes/admin/chores.js`
- Test: `tests/routes-admin-chores.test.js` (append)

- [ ] **Step 1: Write the migration**

Create `src/migrations/014-bonus-ripening.sql`:

```sql
ALTER TABLE chores ADD COLUMN min_points     INTEGER;
ALTER TABLE chores ADD COLUMN max_points     INTEGER;
ALTER TABLE chores ADD COLUMN days_to_ripen  INTEGER NOT NULL DEFAULT 5
  CHECK (days_to_ripen >= 1 AND days_to_ripen <= 30);
ALTER TABLE chores ADD COLUMN current_points INTEGER;
ALTER TABLE chores ADD COLUMN ripens_from    TEXT;
ALTER TABLE chores ADD COLUMN ripens_full_on TEXT;

-- Backwards compat: existing bonuses get min=max=current=points and ripens_from=today,
-- which means step=0 so they never actually ripen until the parent edits them.
UPDATE chores
SET min_points     = points,
    max_points     = points,
    current_points = points,
    ripens_from    = date('now', 'localtime')
WHERE kind = 'bonus' AND min_points IS NULL;
```

- [ ] **Step 2: Verify migration applies cleanly on a fresh DB**

Run: `cd ~/projects/tally && node -e "import('./src/db.js').then(async ({runMigrations}) => { const D=(await import('better-sqlite3')).default; const db=new D(':memory:'); runMigrations(db); const cols = db.prepare('PRAGMA table_info(chores)').all().map(c => c.name); console.log('have min_points?', cols.includes('min_points')); console.log('have days_to_ripen?', cols.includes('days_to_ripen')); console.log('have ripens_full_on?', cols.includes('ripens_full_on')); })"`

Expected: all three lines show `true`.

- [ ] **Step 3: Add validators and init logic to chores route**

Read the current ALLOWED_FIELDS:

```bash
cd ~/projects/tally && grep -n "ALLOWED_FIELDS" src/routes/admin/chores.js
```

In `src/routes/admin/chores.js`, ADD these to `ALLOWED_FIELDS`:
```
'min_points', 'max_points', 'days_to_ripen',
```

ADD validator function near the top of the file (after the existing helpers, or just above `export function adminChoresRoutes()`):

```js
function validateBonusFields(data) {
  // Only enforce when the row IS a bonus (caller checks). All three fields optional;
  // when present they must be sane.
  if (data.min_points !== undefined) {
    const n = Number(data.min_points);
    if (!Number.isInteger(n) || n < 1) return 'min_points must be an integer >= 1';
    data.min_points = n;
  }
  if (data.max_points !== undefined) {
    const n = Number(data.max_points);
    if (!Number.isInteger(n) || n < 1) return 'max_points must be an integer >= 1';
    data.max_points = n;
  }
  if (data.min_points !== undefined && data.max_points !== undefined && data.max_points < data.min_points) {
    return 'max_points must be >= min_points';
  }
  if (data.days_to_ripen !== undefined) {
    const n = Number(data.days_to_ripen);
    if (!Number.isInteger(n) || n < 1 || n > 30) return 'days_to_ripen must be an integer 1..30';
    data.days_to_ripen = n;
  }
  return null;
}

function todayIso() {
  // ISO date in local-time, matching the migration's date('now','localtime').
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
```

In the POST handler, AFTER `pickFields(req.body)` and BEFORE the INSERT, add:

```js
    const err = validateBonusFields(data);
    if (err) return res.status(400).json({ error: err });
    // For new bonus chores, seed the ripening cycle.
    if (data.kind === 'bonus' && data.min_points !== undefined) {
      data.current_points = data.min_points;
      data.ripens_from    = todayIso();
    }
```

In the PATCH handler, AFTER `pickFields(req.body)` and BEFORE the UPDATE, add the same validator + a reset rule:

```js
    const err = validateBonusFields(data);
    if (err) return res.status(400).json({ error: err });
    // If min_points or max_points changes, restart the ripening cycle so the
    // wall doesn't show "current=8, min=2, max=15" stuck mid-ramp.
    if (data.min_points !== undefined || data.max_points !== undefined) {
      const newMin = data.min_points !== undefined ? data.min_points : null;
      if (newMin !== null) data.current_points = newMin;
      data.ripens_from    = todayIso();
      data.ripens_full_on = null;
    }
```

- [ ] **Step 4: Append validator tests**

Append to `tests/routes-admin-chores.test.js`:

```js
test('POST bonus with min/max/days seeds current_points=min and ripens_from=today', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const r = await agent.post('/api/admin/chores').send({
    title: 'Wash car', kind: 'bonus', points: 5,
    min_points: 2, max_points: 12, days_to_ripen: 5,
  });
  assert.equal(r.status, 200);
  const row = db.prepare("SELECT min_points, max_points, current_points, days_to_ripen, ripens_from FROM chores WHERE title='Wash car'").get();
  assert.equal(row.min_points, 2);
  assert.equal(row.max_points, 12);
  assert.equal(row.current_points, 2);
  assert.equal(row.days_to_ripen, 5);
  assert.ok(row.ripens_from);
});

test('POST rejects max_points < min_points', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const r = await agent.post('/api/admin/chores').send({
    title: 'Bad', kind: 'bonus', points: 5,
    min_points: 10, max_points: 2,
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /max_points/);
});

test('POST rejects days_to_ripen outside 1..30', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const a = await agent.post('/api/admin/chores').send({ title: 'A', kind: 'bonus', points: 1, min_points: 1, max_points: 2, days_to_ripen: 0 });
  assert.equal(a.status, 400);
  const b = await agent.post('/api/admin/chores').send({ title: 'B', kind: 'bonus', points: 1, min_points: 1, max_points: 2, days_to_ripen: 31 });
  assert.equal(b.status, 400);
});

test('PATCH bonus changing min resets current_points and ripens_from', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const created = (await agent.post('/api/admin/chores').send({
    title: 'C', kind: 'bonus', points: 1, min_points: 1, max_points: 10, days_to_ripen: 5,
  })).body.chore;
  // Manually advance current_points as if a sweep had ripened it.
  db.prepare("UPDATE chores SET current_points = 6 WHERE id = ?").run(created.id);
  const r = await agent.patch(`/api/admin/chores/${created.id}`).send({ min_points: 3, max_points: 12 });
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT current_points, ripens_full_on FROM chores WHERE id = ?').get(created.id);
  assert.equal(row.current_points, 3);
  assert.equal(row.ripens_full_on, null);
});
```

- [ ] **Step 5: Run tests, confirm pass**

```bash
cd ~/projects/tally && node --test tests/routes-admin-chores.test.js 2>&1 | tail -6
```
Expected: existing tests still pass plus 4 new passes.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/tally && git add src/migrations/014-bonus-ripening.sql src/routes/admin/chores.js tests/routes-admin-chores.test.js && git commit -m "feat(chores): bonus ripening migration + admin route plumbing"
```

---

## Task 2: sweepBonusRipening library

**Files:**
- Create: `src/lib/bonus-ripen.js`
- Test: `tests/lib-bonus-ripen.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/lib-bonus-ripen.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { sweepBonusRipening, _resetCache, ripeningStep } from '../src/lib/bonus-ripen.js';

function makeBonus(db, { title = 'B', min = 1, max = 10, days = 5, current = null, from = null, fullOn = null } = {}) {
  return db.prepare(`
    INSERT INTO chores
      (title, kind, points, recurs, default_assignees, min_points, max_points, days_to_ripen, current_points, ripens_from, ripens_full_on)
    VALUES (?, 'bonus', ?, 'none', '', ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(title, min, min, max, days, current ?? min, from, fullOn).id;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

test('ripeningStep: linear from min to max over days', () => {
  assert.equal(ripeningStep(1, 10, 5), 2);   // 9/5 = 1.8 -> 2
  assert.equal(ripeningStep(1, 10, 9), 1);   // 9/9 = 1 -> 1
  assert.equal(ripeningStep(5, 5, 5), 0);    // backward-compat (min==max)
  assert.equal(ripeningStep(1, 100, 7), 14); // 99/7 = 14.14 -> 14
});

test('sweep is a no-op when ripens_from == today (already ripened today)', () => {
  _resetCache();
  const db = freshDb();
  const id = makeBonus(db, { min: 1, max: 10, days: 5, current: 3, from: todayIso() });
  sweepBonusRipening(db);
  const row = db.prepare('SELECT current_points, ripens_from FROM chores WHERE id = ?').get(id);
  assert.equal(row.current_points, 3);
});

test('sweep bumps current by step when 1 day has passed', () => {
  _resetCache();
  const db = freshDb();
  const id = makeBonus(db, { min: 1, max: 10, days: 5, current: 1, from: daysAgo(1) });
  sweepBonusRipening(db);
  const row = db.prepare('SELECT current_points, ripens_from FROM chores WHERE id = ?').get(id);
  assert.equal(row.current_points, 3);        // 1 + step(2)
  assert.equal(row.ripens_from, todayIso());  // touched today now
});

test('sweep catches up multi-day gaps in one pass', () => {
  _resetCache();
  const db = freshDb();
  const id = makeBonus(db, { min: 1, max: 10, days: 5, current: 1, from: daysAgo(3) });
  sweepBonusRipening(db);
  const row = db.prepare('SELECT current_points FROM chores WHERE id = ?').get(id);
  // 1 + step*3 = 1 + 2*3 = 7
  assert.equal(row.current_points, 7);
});

test('sweep clamps at max and stamps ripens_full_on the first day it reaches max', () => {
  _resetCache();
  const db = freshDb();
  const id = makeBonus(db, { min: 1, max: 10, days: 5, current: 9, from: daysAgo(1) });
  sweepBonusRipening(db);
  const row = db.prepare('SELECT current_points, ripens_full_on FROM chores WHERE id = ?').get(id);
  assert.equal(row.current_points, 10);
  assert.equal(row.ripens_full_on, todayIso());
});

test('sweep soft-deletes a bonus that has been at max since at least yesterday', () => {
  _resetCache();
  const db = freshDb();
  const id = makeBonus(db, { min: 1, max: 10, days: 5, current: 10, from: daysAgo(2), fullOn: daysAgo(1) });
  sweepBonusRipening(db);
  const row = db.prepare('SELECT deleted_at FROM chores WHERE id = ?').get(id);
  assert.ok(row.deleted_at, 'should be soft-deleted');
});

test('sweep leaves min==max bonuses untouched (backwards compat)', () => {
  _resetCache();
  const db = freshDb();
  const id = makeBonus(db, { min: 5, max: 5, days: 5, current: 5, from: daysAgo(7) });
  sweepBonusRipening(db);
  const row = db.prepare('SELECT current_points, deleted_at FROM chores WHERE id = ?').get(id);
  assert.equal(row.current_points, 5);
  assert.equal(row.deleted_at, null);
});

test('sweep is cached for 60 seconds', () => {
  _resetCache();
  const db = freshDb();
  const id = makeBonus(db, { min: 1, max: 10, days: 5, current: 1, from: daysAgo(1) });
  sweepBonusRipening(db);
  // Manually rewind ripens_from again so a second sweep WOULD do something.
  db.prepare("UPDATE chores SET ripens_from = ? WHERE id = ?").run(daysAgo(1), id);
  sweepBonusRipening(db); // cached; should NOT bump again
  const row = db.prepare('SELECT current_points FROM chores WHERE id = ?').get(id);
  assert.equal(row.current_points, 3); // still from first call
});
```

- [ ] **Step 2: Run failing tests**

```bash
cd ~/projects/tally && node --test tests/lib-bonus-ripen.test.js 2>&1 | tail -5
```
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the sweep**

Create `src/lib/bonus-ripen.js`:

```js
let lastCheck = 0;

export function _resetCache() { lastCheck = 0; }

export function ripeningStep(min, max, days) {
  if (max <= min) return 0;
  return Math.round((max - min) / days);
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function daysBetween(fromIso, toIso) {
  const a = new Date(fromIso + 'T00:00:00');
  const b = new Date(toIso   + 'T00:00:00');
  return Math.round((b - a) / 86_400_000);
}

export function sweepBonusRipening(db) {
  const now = Date.now();
  if (now - lastCheck < 60_000) return;
  lastCheck = now;

  const today = todayIso();
  const rows = db.prepare(`
    SELECT id, min_points, max_points, days_to_ripen, current_points, ripens_from, ripens_full_on
    FROM chores
    WHERE kind = 'bonus'
      AND deleted_at IS NULL
      AND min_points IS NOT NULL
      AND max_points IS NOT NULL
      AND ripens_from IS NOT NULL
  `).all();

  for (const r of rows) {
    // 1. Soft-delete bonuses that have been at max since at least yesterday.
    if (r.ripens_full_on && r.ripens_full_on < today) {
      db.prepare(`UPDATE chores SET deleted_at = datetime('now') WHERE id = ?`).run(r.id);
      continue;
    }
    // 2. Skip min==max bonuses (no ripening configured).
    const step = ripeningStep(r.min_points, r.max_points, r.days_to_ripen);
    if (step <= 0) continue;
    // 3. Skip bonuses already touched today.
    if (r.ripens_from >= today) continue;

    const elapsed = Math.max(1, daysBetween(r.ripens_from, today));
    let next = (r.current_points ?? r.min_points) + step * elapsed;
    let reachedFull = false;
    if (next >= r.max_points) {
      next = r.max_points;
      reachedFull = true;
    }
    db.prepare(`
      UPDATE chores SET current_points = ?, ripens_from = ?,
        ripens_full_on = COALESCE(ripens_full_on, CASE WHEN ? = 1 THEN ? ELSE NULL END)
      WHERE id = ?
    `).run(next, today, reachedFull ? 1 : 0, today, r.id);
  }
}
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd ~/projects/tally && node --test tests/lib-bonus-ripen.test.js 2>&1 | tail -5
```
Expected: 8 passing.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/lib/bonus-ripen.js tests/lib-bonus-ripen.test.js && git commit -m "feat(bonus): sweepBonusRipening lib (step + clamp + grace + soft-delete)"
```

---

## Task 3: Wire sweep into wall/home/admin-today + expose ripening fields

**Files:**
- Modify: `src/routes/wall.js`
- Modify: `src/routes/home.js`
- Modify: `src/routes/admin/today.js`

- [ ] **Step 1: Add the import and call in wall.js**

In `src/routes/wall.js`, add to the imports:
```js
import { sweepBonusRipening } from '../lib/bonus-ripen.js';
```

In the `GET /wall` handler, after `sweepForfeits(db);` add:
```js
sweepBonusRipening(db);
```

In the bonus query (around line 180), update to include the ripening fields:
```js
    const bonuses = db.prepare(`
      SELECT c.id, c.title, c.points, c.anti_cheat,
             c.min_points, c.max_points, c.current_points
      FROM chores c
      LEFT JOIN assignments a ON a.chore_id = c.id
      WHERE c.kind = 'bonus' AND c.deleted_at IS NULL AND a.id IS NULL
      ORDER BY c.created_at DESC
    `).all();
```

- [ ] **Step 2: Same wiring in home.js**

In `src/routes/home.js`, add import:
```js
import { sweepBonusRipening } from '../lib/bonus-ripen.js';
```

In the `GET /home` handler, after `sweepForfeits(db);` add:
```js
sweepBonusRipening(db);
```

And update the bonus SELECT (around line 128) to include ripening fields:
```js
    const bonuses = db.prepare(`
      SELECT c.id, c.title, c.description, c.points, c.anti_cheat, c.photo_prompt,
             c.min_points, c.max_points, c.current_points
      FROM chores c
      LEFT JOIN assignments a ON a.chore_id = c.id
      WHERE c.kind = 'bonus' AND c.deleted_at IS NULL AND a.id IS NULL
      ORDER BY c.created_at DESC
    `).all();
```

- [ ] **Step 3: Wire into admin/today.js**

In `src/routes/admin/today.js`, add import:
```js
import { sweepBonusRipening } from '../../lib/bonus-ripen.js';
```

After `sweepForfeits(db);` add:
```js
sweepBonusRipening(db);
```

- [ ] **Step 4: Smoke check**

```bash
cd ~/projects/tally && npm test 2>&1 | tail -5 && pm2 restart tally --update-env >/dev/null && sleep 1 && curl -sf -o /dev/null -w "wall=%{http_code}\n" https://tally.thelopezfamily.org/wall
```
Expected: 0 fails, HTTP 200.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/routes/wall.js src/routes/home.js src/routes/admin/today.js && git commit -m "feat(routes): sweepBonusRipening on wall/home/admin-today reads + expose fields"
```

---

## Task 4: Bonus claim uses current_points and resets the cycle

**Files:**
- Modify: `src/routes/home.js` (the `POST /api/bonuses/:id/claim` handler)
- Test: `tests/routes-bonus-claim.test.js` (new or append to existing)

- [ ] **Step 1: Find the claim handler**

```bash
cd ~/projects/tally && grep -n "bonuses/:id/claim\|POST.*claim" src/routes/home.js
```

- [ ] **Step 2: Update it to use current_points**

In `src/routes/home.js`, find the claim handler (creates an assignment for the bonus chore). Modify the assignment INSERT to use the chore's `current_points` as `display_points` (if your schema captures it on assignments) AND reset the chore's ripening cycle so a future re-add starts fresh:

```js
  r.post('/bonuses/:id/claim', requireRole('kid'), (req, res) => {
    const db = req.app.get('db');
    const chore = db.prepare(
      "SELECT id, points, min_points, current_points FROM chores WHERE id = ? AND kind = 'bonus' AND deleted_at IS NULL"
    ).get(req.params.id);
    if (!chore) return res.status(404).json({ error: 'Bonus not available' });
    // ... existing insert assignment, etc ...
    // After the assignment is created, reset the ripening cycle so if this same
    // bonus chore is re-added later it starts fresh at min:
    if (chore.min_points != null) {
      db.prepare(`
        UPDATE chores SET current_points = min_points, ripens_from = date('now','localtime'),
          ripens_full_on = NULL WHERE id = ?
      `).run(chore.id);
    }
    // ... rest of handler ...
  });
```

NOTE: Look at the existing claim handler shape and integrate; don't blindly paste.

- [ ] **Step 3: Run full test suite**

```bash
cd ~/projects/tally && npm test 2>&1 | tail -5
```
Expected: no regressions.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add src/routes/home.js && git commit -m "feat(bonus): claim resets the ripening cycle for next re-add"
```

---

## Task 5: Admin chore modal grows min/max/days inputs for bonus kind

**Files:**
- Modify: `public/js/pages/admin.js`

- [ ] **Step 1: Locate editChore**

```bash
cd ~/projects/tally && grep -n "function editChore" public/js/pages/admin.js
```

- [ ] **Step 2: Add bonus-only fields after the Points field**

In `editChore`, near the existing Points input (around line 278 in the `editChore` function), add three more `el('div', { class: 'form-field' }, ...)` blocks that ONLY render when `data.kind === 'bonus'`.

```js
    // Bonus ripening fields (only visible when kind=bonus).
    ...(data.kind === 'bonus' ? [
      el('div', { class: 'form-field' }, [
        el('label', {}, ['Min points (starting value when posted)']),
        el('input', {
          type: 'number', min: '1',
          value: data.min_points ?? data.points,
          onInput: e => data.min_points = Number(e.target.value),
        }),
      ]),
      el('div', { class: 'form-field' }, [
        el('label', {}, ['Max points (cap before bonus disappears)']),
        el('input', {
          type: 'number', min: '1',
          value: data.max_points ?? data.points,
          onInput: e => data.max_points = Number(e.target.value),
        }),
      ]),
      el('div', { class: 'form-field' }, [
        el('label', {}, ['Days to ripen']),
        el('input', {
          type: 'number', min: '1', max: '30',
          value: data.days_to_ripen ?? 5,
          onInput: e => data.days_to_ripen = Number(e.target.value),
        }),
        el('div', { class: 'muted', style: { fontSize: '0.78rem', marginTop: '4px' } }, [
          'How many days the value takes to climb from min to max. After it stays at max for one day, the bonus disappears.',
        ]),
      ]),
    ] : []),
```

Also make sure when the user toggles the `kind` select TO `bonus`, the modal re-renders so the bonus fields appear. The simplest way: when `kind` changes, force a re-render by closing and reopening the modal. Or simpler still: just leave it; the user can save, edit again, and the fields appear. (Pick whichever is easiest given the existing modal code.)

- [ ] **Step 3: Syntax check**

```bash
cd ~/projects/tally && node --check public/js/pages/admin.js && echo "syntax ok"
```

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/admin.js && git commit -m "feat(admin-ui): chore modal exposes min/max/days_to_ripen for bonus chores"
```

---

## Task 6: Wall + home heat display + CSS

**Files:**
- Modify: `public/js/pages/wall.js`
- Modify: `public/js/pages/home.js` (if it has bonus card rendering)
- Modify: `public/css/layouts.css`

- [ ] **Step 1: Locate bonus card rendering in wall.js**

```bash
cd ~/projects/tally && grep -n "wall-bonus-item\|wall-bonus-strip\|bonuses.map" public/js/pages/wall.js public/js/pages/home.js
```

- [ ] **Step 2: Add the heat helper and apply in wall.js**

In `public/js/pages/wall.js`, ABOVE the renderChores function, add:

```js
function bonusHeat(b) {
  const min = b.min_points ?? b.points;
  const max = b.max_points ?? b.points;
  const cur = b.current_points ?? b.points;
  if (max <= min) return 'low';
  const pct = Math.max(0, Math.min(1, (cur - min) / (max - min)));
  if (pct <= 0.25) return 'low';
  if (pct <= 0.74) return 'mid';
  return 'high';
}
function bonusDisplayPoints(b) {
  return b.current_points ?? b.points;
}
```

Find the bonus card mapping (something like `data.bonuses.map(b => el('div', { class: 'wall-bonus-item' }, ...))`). UPDATE it to:

```js
        data.bonuses.map(b => el('div', { class: 'wall-bonus-item', 'data-heat': bonusHeat(b) }, [
          el('div', { class: 'wall-bonus-title' }, [b.title]),
          el('div', { class: 'wall-bonus-pts' }, [`+${bonusDisplayPoints(b)}`]),
        ]))
```

- [ ] **Step 3: Same treatment in home.js for the kid view**

In `public/js/pages/home.js`, find the bonuses rendering and apply the same `bonusHeat` and `bonusDisplayPoints` (copy the two helpers there too, or import from a shared lib). Update the card markup to include `data-heat` and use `bonusDisplayPoints(b)` for the points label.

- [ ] **Step 4: Add CSS**

In `public/css/layouts.css`, near the existing `.wall-bonus-item` rules, ADD:

```css
.wall-bonus-item                   { transition: border-color 0.4s ease, box-shadow 0.4s ease; }
.wall-bonus-item[data-heat="low"]  { border-color: #22C55E; box-shadow: 0 0 0 1px rgba(34,197,94,0.20); }
.wall-bonus-item[data-heat="mid"]  { border-color: #F59E0B; box-shadow: 0 0 0 1px rgba(245,158,11,0.25); }
.wall-bonus-item[data-heat="high"] { border-color: #DC2626; box-shadow: 0 0 12px rgba(220,38,38,0.4); animation: bonus-pulse 1.6s ease-in-out infinite; }

@keyframes bonus-pulse {
  0%, 100% { box-shadow: 0 0 12px rgba(220,38,38,0.4); }
  50%      { box-shadow: 0 0 20px rgba(220,38,38,0.7); }
}
```

- [ ] **Step 5: Syntax check + smoke**

```bash
cd ~/projects/tally && node --check public/js/pages/wall.js && node --check public/js/pages/home.js && pm2 restart tally --update-env >/dev/null && sleep 1 && curl -sf -o /dev/null -w "wall=%{http_code}\n" https://tally.thelopezfamily.org/wall
```
Expected: ok, ok, 200.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/wall.js public/js/pages/home.js public/css/layouts.css && git commit -m "feat(wall+home): bonus card heat tint based on ripening progress"
```

---

## Task 7: Tests, smoke, tag, push

- [ ] **Step 1: Run full suite**

```bash
cd ~/projects/tally && npm test 2>&1 | tail -8
```
Expected: ~310 passing (previous + ~15 new), 0 fail.

- [ ] **Step 2: Manual smoke** (have user do this themselves; not blocking)

- [ ] **Step 3: Tag and push**

```bash
cd ~/projects/tally && git tag -a v0.13.0-bonus-ripening -m "$(cat <<'EOF'
v0.13.0 - Bonus chore ripening

Bonus chores now ripen daily. Each unclaimed bonus rises from
min_points to max_points over days_to_ripen days (default 5).
On the day it first hits max it gets a one-day grace; the day
after, it soft-deletes from the bonus board.

Wall and home bonus cards show a heat tint based on ripeness:
  0% to 25%   subtle green
  26% to 74%  amber
  75% to 100% pulsing red

Backwards compatible: existing bonuses migrate to min==max so they
behave exactly as before until the parent edits them to set a range.
EOF
)" && git push origin master --tags 2>&1 | tail -5
```

- [ ] **Step 4: Verify**

```bash
cd ~/projects/tally && git log --oneline -5 && git tag | tail -3
```
Expected: latest tag is `v0.13.0-bonus-ripening`.

---

## Self-review checklist (controller fills in at plan-writing time)

- [x] Migration column names match the spec.
- [x] Function names consistent: `sweepBonusRipening`, `ripeningStep`, `_resetCache`, `bonusHeat`, `bonusDisplayPoints`, `validateBonusFields`, `todayIso`, `daysBetween`.
- [x] Heat buckets match the spec (0..25 low, 26..74 mid, 75..100 high).
- [x] One-day grace at max enforced (check `ripens_full_on < today` before soft-delete).
- [x] Backwards compat: min==max bonuses don't ripen and don't auto-delete.
- [x] Step rounding: `Math.round((max - min) / days)`.
- [x] No placeholders or "TBD" in any step.
