# Tally — Phase 2a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fixed `chores.points` with a weighted (1-5) dynamic point system that ties to the per-kid weekly target, add chore stealing after a configurable unlock time, and surface live points + projected pay on the kid hero card and admin views.

**Architecture:** Schema gets `chores.weight`, `chores.is_school_work`, `assignments.stolen_from`, and a `steal_unlock_time` setting. A new `src/lib/points.js` module exposes pure functions `calcWeekPoints(db, personId, weekStartIso)` and `calcProjectedPay(person, points)` consumed by `/api/home`, `/api/wall`, and `/api/admin/today`. A new `POST /api/assignments/:id/steal` endpoint moves ownership atomically. Frontend adds weight + school-work fields to the chore modal, a new Settings tab for the unlock-time, dynamic point displays, and a Steal section on the kid home.

**Tech Stack:** Same as Phase 1/3 — Node 20+, Express 5, better-sqlite3, vanilla JS SPA. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-05-26-tally-phase-2a-points-stealing.md`](../specs/2026-05-26-tally-phase-2a-points-stealing.md)

**Prior phases:** Phase 1 (skeleton) + Phase 3 (anti-cheat) already shipped. Phase 2a sits on top of both.

**Scope guardrails:** No ledger entries, no Sunday settle UI, no bank balance. Those are Phase 2b.

---

## File Structure

```
~/projects/tally/
├── src/
│   ├── migrations/
│   │   └── 004-points-and-stealing.sql      NEW
│   ├── lib/
│   │   └── points.js                         NEW: calcWeekPoints, calcProjectedPay
│   └── routes/
│       ├── home.js                           MODIFIED: home payload + steal endpoint
│       ├── wall.js                           MODIFIED: per-kid points/percent
│       └── admin/
│           ├── chores.js                     MODIFIED: weight + is_school_work in ALLOWED_FIELDS
│           ├── today.js                      MODIFIED: per-kid points + projected_pay
│           └── settings.js                   NEW: GET/PATCH settings
└── public/
    ├── js/pages/
    │   ├── home.js                           MODIFIED: hero + dynamic points + steal section
    │   ├── admin.js                          MODIFIED: weight/school fields + Settings tab
    │   └── wall.js                           MODIFIED: per-kid points/percent + stolen badge
    └── css/layouts.css                       MODIFIED: steal section + settings styles

tests/
├── lib-points.test.js                        NEW
├── routes-steal.test.js                      NEW
└── routes-admin-settings.test.js             NEW
```

---

## Task 1: Migration 004 — weight, school-work, stolen_from, unlock-time setting

**Files:**
- Create: `src/migrations/004-points-and-stealing.sql`
- Test: extend `tests/auth.test.js` with a smoke check

- [ ] **Step 1: Append the failing schema test to `tests/auth.test.js`**

Open `tests/auth.test.js` and append at the bottom:

```js
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
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL on the new test — columns don't exist.

- [ ] **Step 3: Create `src/migrations/004-points-and-stealing.sql`**

```sql
ALTER TABLE chores ADD COLUMN weight INTEGER NOT NULL DEFAULT 3
  CHECK (weight BETWEEN 1 AND 5);
ALTER TABLE chores ADD COLUMN is_school_work INTEGER NOT NULL DEFAULT 0
  CHECK (is_school_work IN (0, 1));

ALTER TABLE assignments ADD COLUMN stolen_from INTEGER REFERENCES people(id);
CREATE INDEX idx_assignments_stolen_from ON assignments(stolen_from)
  WHERE stolen_from IS NOT NULL;

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('steal_unlock_time', '16:00');
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 60 tests (59 prior + 1 new).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/migrations/004-points-and-stealing.sql tests/auth.test.js && git commit -m "feat(db): 004 weight + is_school_work + stolen_from + steal_unlock_time"
```

---

## Task 2: `src/lib/points.js` — pure point math

**Files:**
- Create: `src/lib/points.js`, `tests/lib-points.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/lib-points.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { calcWeekPoints, calcProjectedPay } from '../src/lib/points.js';
import { weekStart, today } from '../src/lib/dates.js';

function seedKid(db, name = 'K', target = 100) {
  return db.prepare(
    "INSERT INTO people (name, role, weekly_target_pts, base_pay_cents, bonus_rate_cents) VALUES (?, 'kid', ?, 1000, 10) RETURNING id"
  ).get(name, target).id;
}
function seedChore(db, weight, isSchool = 0) {
  return db.prepare(
    "INSERT INTO chores (title, weight, is_school_work, recurs) VALUES ('T', ?, ?, 'daily') RETURNING id"
  ).get(weight, isSchool).id;
}
function seedAssignment(db, choreId, kidId, dueDate, status = 'pending', extras = {}) {
  const cols = ['chore_id', 'person_id', 'due_date', 'status'];
  const vals = [choreId, kidId, dueDate, status];
  for (const [k, v] of Object.entries(extras)) {
    cols.push(k); vals.push(v);
  }
  return db.prepare(`INSERT INTO assignments (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')}) RETURNING id`).get(...vals).id;
}

test('calcWeekPoints with no assignments returns zeros', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const r = calcWeekPoints(db, kid, weekStart(today()));
  assert.deepEqual(r, { totalWeight: 0, doneWeight: 0, percent: 0, points: 0 });
});

test('calcWeekPoints sums weights and computes percent', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const ws = weekStart(today());
  const c1 = seedChore(db, 3);
  const c2 = seedChore(db, 2);
  seedAssignment(db, c1, kid, today(), 'done');
  seedAssignment(db, c2, kid, today(), 'pending');
  const r = calcWeekPoints(db, kid, ws);
  assert.equal(r.totalWeight, 5);
  assert.equal(r.doneWeight, 3);
  assert.equal(r.percent, 0.6);
  assert.equal(r.points, 60);
});

test('calcWeekPoints counts stolen-away in denominator (original kid still on the hook)', () => {
  const db = freshDb();
  const original = seedKid(db, 'Original');
  const stealer = seedKid(db, 'Stealer');
  const ws = weekStart(today());
  const c = seedChore(db, 4);
  seedAssignment(db, c, stealer, today(), 'pending', { stolen_from: original });
  const r = calcWeekPoints(db, original, ws);
  assert.equal(r.totalWeight, 4, 'stolen-away weight stays in denominator');
  assert.equal(r.doneWeight, 0);
  assert.equal(r.percent, 0);
});

test('calcWeekPoints counts stolen-in in done but NOT in total (extra credit)', () => {
  const db = freshDb();
  const original = seedKid(db, 'Original');
  const stealer = seedKid(db, 'Stealer');
  const ws = weekStart(today());
  const own = seedChore(db, 5);
  const stolen = seedChore(db, 2);
  seedAssignment(db, own, stealer, today(), 'done');
  seedAssignment(db, stolen, stealer, today(), 'done', { stolen_from: original });
  const r = calcWeekPoints(db, stealer, ws);
  assert.equal(r.totalWeight, 5, 'stolen-in does NOT enter denominator');
  assert.equal(r.doneWeight, 7, 'stolen-in done DOES enter numerator');
  assert.equal(r.percent, 1.4);
  assert.equal(r.points, 140);
});

test('calcProjectedPay returns base for 100%, base+bonus for >100%, prorated for <100%', () => {
  const person = { weekly_target_pts: 100, base_pay_cents: 1000, bonus_rate_cents: 10 };

  assert.equal(calcProjectedPay(person, 50), 500, 'half = $5');
  assert.equal(calcProjectedPay(person, 100), 1000, 'target = $10 base');
  assert.equal(calcProjectedPay(person, 106), 1060, '106 pts = base + 6 * 10c = $10.60');
  assert.equal(calcProjectedPay(person, 0), 0, 'no progress = $0');
});

test('calcProjectedPay handles zero target gracefully', () => {
  const person = { weekly_target_pts: 0, base_pay_cents: 1000, bonus_rate_cents: 10 };
  assert.equal(calcProjectedPay(person, 0), 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/points.js`**

```js
import { weekStart, fromIso, toIso } from './dates.js';

/**
 * Compute the weekly points for a kid given a week-start ISO date.
 * Returns { totalWeight, doneWeight, percent, points }.
 *
 * Denominator (totalWeight) = sum of weights of chores currently theirs
 * (and never stolen) PLUS chores stolen FROM them. They're on the hook
 * for everything originally assigned.
 *
 * Numerator (doneWeight) = sum of weights of chores currently theirs
 * AND done. Stolen-in done chores count; stolen-away done chores don't
 * (because the row's person_id is now the stealer's, not the original's).
 */
export function calcWeekPoints(db, personId, weekStartIso) {
  const start = fromIso(weekStartIso);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const startStr = weekStartIso;
  const endStr = toIso(end);

  const totalRow = db.prepare(`
    SELECT COALESCE(SUM(c.weight), 0) AS w
    FROM assignments a
    JOIN chores c ON c.id = a.chore_id
    WHERE a.due_date BETWEEN ? AND ?
      AND (
        (a.person_id = ? AND a.stolen_from IS NULL)
        OR a.stolen_from = ?
      )
  `).get(startStr, endStr, personId, personId);

  const doneRow = db.prepare(`
    SELECT COALESCE(SUM(c.weight), 0) AS w
    FROM assignments a
    JOIN chores c ON c.id = a.chore_id
    WHERE a.due_date BETWEEN ? AND ?
      AND a.person_id = ?
      AND a.status = 'done'
  `).get(startStr, endStr, personId);

  const person = db.prepare('SELECT weekly_target_pts FROM people WHERE id = ?').get(personId);
  const target = person?.weekly_target_pts || 0;

  const totalWeight = totalRow.w;
  const doneWeight = doneRow.w;
  const percent = totalWeight === 0 ? 0 : doneWeight / totalWeight;
  const points = Math.round(percent * target);

  return { totalWeight, doneWeight, percent, points };
}

/**
 * Given a `people` row and a points count, return projected weekly pay in cents.
 * - Base: linear from 0 up to base_pay_cents at 100% of target.
 * - Bonus: bonus_rate_cents per point earned over target.
 */
export function calcProjectedPay(person, points) {
  const target = person.weekly_target_pts || 0;
  const base = person.base_pay_cents || 0;
  const bonusRate = person.bonus_rate_cents || 0;
  if (target === 0) return 0;
  const cappedPct = Math.min(points / target, 1.0);
  const basePart = Math.round(cappedPct * base);
  const extraPoints = Math.max(0, points - target);
  const bonusPart = extraPoints * bonusRate;
  return basePart + bonusPart;
}
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 66 tests (60 prior + 6 new).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/lib/points.js tests/lib-points.test.js && git commit -m "feat(lib): points.js with calcWeekPoints + calcProjectedPay"
```

---

## Task 3: Wire `calcWeekPoints` into `/api/home`

**Files:**
- Modify: `src/routes/home.js`
- Modify: `tests/routes-home.test.js`

- [ ] **Step 1: Append a new test to `tests/routes-home.test.js`**

Open `tests/routes-home.test.js` and append at the bottom:

```js
test('GET /api/home populates points_this_week, percent, projected_pay_cents', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role, weekly_target_pts, base_pay_cents, bonus_rate_cents) VALUES ('K','kid',100,1000,10) RETURNING id").get().id;
  const c1 = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees, anti_cheat) VALUES ('A', 3, 'daily', ?, 'honor') RETURNING id").get(String(kid)).id;
  const c2 = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees, anti_cheat) VALUES ('B', 2, 'daily', ?, 'honor') RETURNING id").get(String(kid)).id;
  // assignment for c1 done, c2 pending — 3 out of 5 weight done
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now'), 'done')").run(c1, kid);
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now'), 'pending')").run(c2, kid);

  const app = freshApp(db);
  const agent = await loginAs(app, kid);
  const res = await agent.get('/api/home');
  assert.equal(res.status, 200);
  assert.equal(res.body.person.points_this_week, 60);
  assert.equal(res.body.person.projected_pay_cents, 600);
  assert.ok(Array.isArray(res.body.today));
  // each row should have a display_points field
  for (const r of res.body.today) {
    assert.ok(typeof r.display_points === 'number', `display_points missing on ${r.title}`);
  }
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL — `points_this_week` and `projected_pay_cents` aren't populated.

- [ ] **Step 3: Update `src/routes/home.js`**

Read the existing file. Replace the GET /home handler within `homeRoutes`. The handler block currently looks like:

```js
  r.get('/home', requireRole('kid'), (req, res) => {
    const db = req.app.get('db');
    const personId = req.user.person_id;
    const person = db.prepare(`
      SELECT id, name, avatar_color, weekly_target_pts, base_pay_cents, bonus_rate_cents,
             bank_cents, streak_days
      FROM people WHERE id = ?
    `).get(personId);

    const assignments = db.prepare(`
      SELECT a.id, a.due_date, a.status, a.note, a.photo_path,
             c.title, c.points, c.anti_cheat
      FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      WHERE a.person_id = ?
        AND (a.due_date = ? OR (a.due_date < ? AND a.status NOT IN ('done','expired','rejected')))
      ORDER BY a.due_date, c.title
    `).all(personId, today(), today());

    const todayList = assignments.filter(a => a.due_date === today());
    const overdueList = assignments.filter(a => a.due_date !== today());
    res.json({ person, today: todayList, overdue: overdueList });
  });
```

Replace with (adds points/projected_pay on person, display_points on each assignment, stolen_from name):

```js
  r.get('/home', requireRole('kid'), (req, res) => {
    const db = req.app.get('db');
    const personId = req.user.person_id;
    const person = db.prepare(`
      SELECT id, name, avatar_color, weekly_target_pts, base_pay_cents, bonus_rate_cents,
             bank_cents, streak_days
      FROM people WHERE id = ?
    `).get(personId);

    const ws = weekStart(today());
    const pts = calcWeekPoints(db, personId, ws);
    person.points_this_week = pts.points;
    person.percent = pts.percent;
    person.projected_pay_cents = calcProjectedPay(person, pts.points);

    const assignments = db.prepare(`
      SELECT a.id, a.due_date, a.status, a.note, a.photo_path,
             a.stolen_from,
             c.title, c.weight, c.anti_cheat,
             sf.name AS stolen_from_name
      FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      LEFT JOIN people sf ON sf.id = a.stolen_from
      WHERE a.person_id = ?
        AND (a.due_date = ? OR (a.due_date < ? AND a.status NOT IN ('done','expired','rejected')))
      ORDER BY a.due_date, c.title
    `).all(personId, today(), today());

    const target = person.weekly_target_pts || 0;
    for (const a of assignments) {
      a.display_points = pts.totalWeight > 0
        ? Math.round(a.weight / pts.totalWeight * target)
        : 0;
    }

    const todayList = assignments.filter(a => a.due_date === today());
    const overdueList = assignments.filter(a => a.due_date !== today());
    res.json({ person, today: todayList, overdue: overdueList });
  });
```

Also add these imports at the top of `src/routes/home.js` (after the existing imports):

```js
import { weekStart } from '../lib/dates.js';
import { calcWeekPoints, calcProjectedPay } from '../lib/points.js';
```

- [ ] **Step 4: Update existing test that referenced `c.points` field**

The existing home test (`tests/routes-home.test.js`) seeds a chore with `points` and the new code reads `c.weight`. The seed line:

```js
INSERT INTO chores (title, points, recurs, default_assignees, anti_cheat) VALUES ('Make bed', 5, 'daily', ?, 'honor')
```

Add `weight` so it doesn't fall back to the default 3 in an unexpected way (the test asserts on titles, not points, so this is mostly hygiene):

```js
INSERT INTO chores (title, points, weight, recurs, default_assignees, anti_cheat) VALUES ('Make bed', 5, 3, 'daily', ?, 'honor')
```

(Apply this same edit to any existing test that inserts into `chores` — see Task 4 for the migration.)

- [ ] **Step 5: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 67 tests (66 prior + 1 new).

- [ ] **Step 6: Commit**

```bash
cd ~/projects/tally && git add src/routes/home.js tests/routes-home.test.js && git commit -m "feat(home): GET /api/home returns points + projected pay + display_points"
```

---

## Task 4: Update other test seeds to set `weight`

**Context:** Phase 2a adds `chores.weight` with a CHECK constraint and DEFAULT 3. Test fixtures that insert into `chores` without specifying weight still work (default applies), but the test for the home API above asserts on specific point values that depend on weight. Audit and explicitly set weight where the test math depends on it.

**Files:**
- Modify: `tests/routes-submit.test.js`, `tests/routes-admin-approvals.test.js`, `tests/routes-admin-day-review.test.js`, `tests/routes-undo.test.js`, `tests/routes-wall.test.js`

- [ ] **Step 1: Sanity-check that ALL existing tests still pass with the migration**

```bash
cd ~/projects/tally && npm test
```

Expected: all green (the migration default of 3 covers existing tests that don't set weight).

If any fail, the failure points to a place where the test does math on `chore.points` and needs to be updated. Treat each failure as a fix and update that test's `INSERT INTO chores` to set `weight = N` explicitly so the test is robust to future changes.

- [ ] **Step 2: Commit any test fixture updates**

```bash
cd ~/projects/tally && git add tests/ && git commit -m "chore(tests): set chores.weight explicitly where test math depends on it"
```

If no changes were needed, skip the commit.

---

## Task 5: Wire `calcWeekPoints` into `/api/wall`

**Files:**
- Modify: `src/routes/wall.js`
- Modify: `tests/routes-wall.test.js`

- [ ] **Step 1: Append a new test to `tests/routes-wall.test.js`**

```js
test('GET /api/wall populates per-kid points, percent, and stolen_from_name on stolen rows', async () => {
  const db = freshDb();
  const a = db.prepare("INSERT INTO people (name, role, weekly_target_pts) VALUES ('A','kid',100) RETURNING id").get().id;
  const b = db.prepare("INSERT INTO people (name, role, weekly_target_pts) VALUES ('B','kid',100) RETURNING id").get().id;
  const c1 = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('X',2,'daily',?) RETURNING id").get(String(a)).id;
  // assignment given to B, but stolen from A
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status, stolen_from) VALUES (?, ?, date('now'), 'pending', ?)").run(c1, b, a);

  const res = await request(freshApp(db)).get('/api/wall');
  assert.equal(res.status, 200);
  const kidA = res.body.kids.find(k => k.name === 'A');
  const kidB = res.body.kids.find(k => k.name === 'B');
  assert.ok(typeof kidA.points === 'number');
  assert.ok(typeof kidA.percent === 'number');
  // A's denominator includes the stolen-away weight (2)
  assert.equal(kidA.percent, 0);
  // B's view shows the chore with stolen_from_name = 'A'
  const stolenRow = kidB.today.find(t => t.title === 'X');
  assert.ok(stolenRow);
  assert.equal(stolenRow.stolen_from_name, 'A');
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL — `points`, `percent`, `stolen_from_name` aren't there.

- [ ] **Step 3: Update `src/routes/wall.js`**

REPLACE the entire contents with:

```js
import { Router } from 'express';
import { today, weekStart } from '../lib/dates.js';
import { calcWeekPoints } from '../lib/points.js';

export function wallRoutes() {
  const r = Router();

  r.get('/wall', (req, res) => {
    const db = req.app.get('db');
    const kids = db.prepare(`
      SELECT id, name, avatar_color, weekly_target_pts, streak_days
      FROM people WHERE role = 'kid' ORDER BY id
    `).all();

    const todayIso = today();
    const ws = weekStart(todayIso);

    const kidIds = kids.map(k => k.id);
    const assignmentRows = kidIds.length === 0 ? [] : db.prepare(`
      SELECT a.id, a.person_id, a.due_date, a.status, a.stolen_from,
             c.title, c.weight,
             sf.name AS stolen_from_name
      FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      LEFT JOIN people sf ON sf.id = a.stolen_from
      WHERE a.person_id IN (${kidIds.map(() => '?').join(',')})
        AND (a.due_date = ? OR (a.due_date < ? AND a.status NOT IN ('done','expired','rejected')))
      ORDER BY a.due_date, c.title
    `).all(...kidIds, todayIso, todayIso);

    let total = 0, done = 0;
    for (const kid of kids) {
      kid.today = [];
      kid.overdue = [];
      const pts = calcWeekPoints(db, kid.id, ws);
      kid.points = pts.points;
      kid.percent = pts.percent;
    }
    for (const a of assignmentRows) {
      const kid = kids.find(k => k.id === a.person_id);
      if (!kid) continue;
      const target = kid.weekly_target_pts || 0;
      const totalWeight = calcWeekPoints(db, kid.id, ws).totalWeight;
      a.display_points = totalWeight > 0 ? Math.round(a.weight / totalWeight * target) : 0;
      const bucket = a.due_date === todayIso ? kid.today : kid.overdue;
      bucket.push(a);
      total++;
      if (a.status === 'done') done++;
    }
    const housePct = total === 0 ? 100 : Math.round((done / total) * 100);

    res.json({ kids, house_pct: housePct, today: todayIso });
  });

  return r;
}
```

Note: `calcWeekPoints` is called inside the per-assignment loop, which is technically redundant (already called above). For Phase 2a clarity over micro-optimization, leave it; if perf becomes an issue, cache the `totalWeight` lookup per kid.

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 68 tests (67 prior + 1 new).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/routes/wall.js tests/routes-wall.test.js && git commit -m "feat(wall): per-kid points + percent + stolen_from on chore rows"
```

---

## Task 6: Wire `calcWeekPoints` + `calcProjectedPay` into `/api/admin/today`

**Files:**
- Modify: `src/routes/admin/today.js`
- Modify: `tests/routes-admin-today.test.js`

- [ ] **Step 1: Append a new test**

```js
test('GET /api/admin/today returns points, percent, projected_pay_cents per kid', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role, weekly_target_pts, base_pay_cents, bonus_rate_cents) VALUES ('K','kid',100,1000,10) RETURNING id").get().id;
  const c = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('A', 2, 'daily', ?) RETURNING id").get(String(kid)).id;
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now'), 'done')").run(c, kid);

  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.get('/api/admin/today');
  assert.equal(res.status, 200);
  const k = res.body.kids[0];
  assert.equal(k.points, 100, 'all weight done = 100 pts');
  assert.equal(k.percent, 1);
  assert.equal(k.projected_pay_cents, 1000);
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL — fields not present.

- [ ] **Step 3: Update `src/routes/admin/today.js`**

REPLACE the entire contents with:

```js
import { Router } from 'express';
import { requireRole } from '../../auth.js';
import { today, weekStart } from '../../lib/dates.js';
import { calcWeekPoints, calcProjectedPay } from '../../lib/points.js';

export function adminTodayRoutes() {
  const r = Router();
  r.use(requireRole('parent'));

  r.get('/today', (req, res) => {
    const db = req.app.get('db');
    const t = today();
    const ws = weekStart(t);
    const kids = db.prepare(`
      SELECT id, name, avatar_color, weekly_target_pts, base_pay_cents, bonus_rate_cents
      FROM people WHERE role = 'kid' ORDER BY name
    `).all();

    let total = 0, done = 0;
    for (const k of kids) {
      const rows = db.prepare(`
        SELECT status, due_date FROM assignments
        WHERE person_id = ?
          AND (due_date = ? OR (due_date < ? AND status NOT IN ('done','expired','rejected')))
      `).all(k.id, t, t);
      k.today_total = rows.filter(r => r.due_date === t).length;
      k.today_done = rows.filter(r => r.due_date === t && r.status === 'done').length;
      k.overdue = rows.filter(r => r.due_date !== t).length;
      total += k.today_total;
      done += k.today_done;

      const pts = calcWeekPoints(db, k.id, ws);
      k.points = pts.points;
      k.percent = pts.percent;
      k.projected_pay_cents = calcProjectedPay(k, pts.points);
    }
    res.json({
      house_pct: total === 0 ? 100 : Math.round((done / total) * 100),
      kids, total, done, today: t,
    });
  });

  return r;
}
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 69 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/routes/admin/today.js tests/routes-admin-today.test.js && git commit -m "feat(admin): today endpoint returns per-kid points + percent + projected pay"
```

---

## Task 7: Chore admin accepts `weight` + `is_school_work`

**Files:**
- Modify: `src/routes/admin/chores.js`
- Modify: `tests/routes-admin-chores.test.js`

- [ ] **Step 1: Append a new test**

```js
test('chore POST/PATCH accepts weight (1-5) and is_school_work', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const agent = await asParent(app, db);

  const c = await agent.post('/api/admin/chores').send({
    title: 'Mow', weight: 5, is_school_work: 0, recurs: 'weekly', anti_cheat: 'honor',
  });
  assert.equal(c.status, 200);
  assert.equal(c.body.chore.weight, 5);
  assert.equal(c.body.chore.is_school_work, 0);

  const p = await agent.patch(`/api/admin/chores/${c.body.chore.id}`).send({ is_school_work: 1, weight: 2 });
  assert.equal(p.body.chore.weight, 2);
  assert.equal(p.body.chore.is_school_work, 1);
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL — fields not in ALLOWED_FIELDS.

- [ ] **Step 3: Update `src/routes/admin/chores.js`**

In the file, find:

```js
const ALLOWED_FIELDS = [
  'title', 'description', 'points', 'kind',
  'recurs', 'recurs_days', 'recurs_anchor', 'due_time',
  'anti_cheat', 'late_tax_pct', 'photo_prompt', 'default_assignees',
];
```

Replace with:

```js
const ALLOWED_FIELDS = [
  'title', 'description', 'points', 'kind',
  'recurs', 'recurs_days', 'recurs_anchor', 'due_time',
  'anti_cheat', 'late_tax_pct', 'photo_prompt', 'default_assignees',
  'weight', 'is_school_work',
];
```

(Leave `points` in the list — it's still in the schema; we just stop relying on it for display.)

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 70 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/routes/admin/chores.js tests/routes-admin-chores.test.js && git commit -m "feat(admin/chores): accept weight + is_school_work in POST/PATCH"
```

---

## Task 8: Settings endpoints + Settings tab

**Files:**
- Create: `src/routes/admin/settings.js`, `tests/routes-admin-settings.test.js`
- Modify: `src/app.js`

- [ ] **Step 1: Write the failing test**

Create `tests/routes-admin-settings.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';

async function asParent(app, db) {
  const id = db.prepare("INSERT INTO people (name, role) VALUES ('Mom','parent') RETURNING id").get().id;
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id, pin: '1234' });
  return agent;
}

test('GET /api/admin/settings returns all settings as a map', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.get('/api/admin/settings');
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.steal_unlock_time, '16:00');
});

test('PATCH /api/admin/settings/:key updates a single setting', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.patch('/api/admin/settings/steal_unlock_time').send({ value: '17:30' });
  assert.equal(res.status, 200);
  assert.equal(res.body.setting.value, '17:30');
  assert.equal(
    db.prepare("SELECT value FROM settings WHERE key='steal_unlock_time'").get().value,
    '17:30'
  );
});

test('PATCH rejects unknown keys (whitelist)', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.patch('/api/admin/settings/admin_pin_hash').send({ value: 'bad' });
  assert.equal(res.status, 400);
});

test('settings endpoints reject non-parent', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: kid });
  const res = await agent.get('/api/admin/settings');
  assert.equal(res.status, 403);
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL.

- [ ] **Step 3: Create `src/routes/admin/settings.js`**

```js
import { Router } from 'express';
import { requireRole } from '../../auth.js';

// Whitelist of settings the API can write. Read access returns everything
// (no secrets are stored under these keys — secrets like admin_pin_hash
// are managed elsewhere and never editable via this endpoint).
const EDITABLE_KEYS = new Set([
  'steal_unlock_time',
  'late_tax_pct_default',
  'reminder_time',
  'payout_day',
  'payout_time',
  'photo_retention_days',
  'wall_theme',
]);

// Keys we expose on GET. Excludes anything secret.
const READABLE_KEYS = new Set([
  ...EDITABLE_KEYS,
]);

export function adminSettingsRoutes() {
  const r = Router();
  r.use(requireRole('parent'));

  r.get('/settings', (req, res) => {
    const db = req.app.get('db');
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const settings = {};
    for (const row of rows) {
      if (READABLE_KEYS.has(row.key)) settings[row.key] = row.value;
    }
    res.json({ settings });
  });

  r.patch('/settings/:key', (req, res) => {
    const db = req.app.get('db');
    const key = req.params.key;
    if (!EDITABLE_KEYS.has(key)) {
      return res.status(400).json({ error: 'Setting is not editable' });
    }
    const { value } = req.body || {};
    if (typeof value !== 'string') {
      return res.status(400).json({ error: 'value must be a string' });
    }
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
    res.json({ setting: { key, value } });
  });

  return r;
}
```

- [ ] **Step 4: Wire into `src/app.js`**

Read the current file. Add the import:

```js
import { adminSettingsRoutes } from './routes/admin/settings.js';
```

And the mount, after the other admin mounts:

```js
  app.use('/api/admin', adminSettingsRoutes());
```

- [ ] **Step 5: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 74 tests (70 prior + 4 new).

- [ ] **Step 6: Commit**

```bash
cd ~/projects/tally && git add src/routes/admin/settings.js src/app.js tests/routes-admin-settings.test.js && git commit -m "feat(admin): settings GET + PATCH endpoints with whitelist"
```

---

## Task 9: `POST /api/assignments/:id/steal` endpoint + `stealable` list on `/api/home`

**Files:**
- Modify: `src/routes/home.js`
- Create: `tests/routes-steal.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/routes-steal.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function setUnlockMinutesAgo(db, minutes) {
  const d = new Date(Date.now() - minutes * 60 * 1000);
  const hhmm = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  db.prepare("UPDATE settings SET value = ? WHERE key = 'steal_unlock_time'").run(hhmm);
}
function setUnlockMinutesFromNow(db, minutes) {
  const d = new Date(Date.now() + minutes * 60 * 1000);
  const hhmm = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  db.prepare("UPDATE settings SET value = ? WHERE key = 'steal_unlock_time'").run(hhmm);
}
function seedKid(db, name) {
  return db.prepare("INSERT INTO people (name, role, weekly_target_pts) VALUES (?, 'kid', 100) RETURNING id").get(name).id;
}
function seedChore(db, title, weight = 3, isSchool = 0) {
  return db.prepare("INSERT INTO chores (title, weight, is_school_work, recurs) VALUES (?, ?, ?, 'daily') RETURNING id").get(title, weight, isSchool).id;
}
function seedAssignment(db, choreId, kidId, status = 'pending') {
  return db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now'), ?) RETURNING id").get(choreId, kidId, status).id;
}
async function loginKid(app, id) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id });
  return agent;
}

test('POST /api/assignments/:id/steal succeeds after unlock time on non-school pending chore', async () => {
  const db = freshDb();
  setUnlockMinutesAgo(db, 60);
  const owner = seedKid(db, 'Owner');
  const stealer = seedKid(db, 'Stealer');
  const cId = seedChore(db, 'X', 3, 0);
  const aId = seedAssignment(db, cId, owner);

  const app = freshApp(db);
  const agent = await loginKid(app, stealer);
  const res = await agent.post(`/api/assignments/${aId}/steal`);
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT * FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.person_id, stealer);
  assert.equal(row.stolen_from, owner);
});

test('steal returns 400 before unlock time', async () => {
  const db = freshDb();
  setUnlockMinutesFromNow(db, 60); // unlocks in an hour
  const owner = seedKid(db, 'Owner');
  const stealer = seedKid(db, 'Stealer');
  const cId = seedChore(db, 'X', 3, 0);
  const aId = seedAssignment(db, cId, owner);
  const app = freshApp(db);
  const agent = await loginKid(app, stealer);
  const res = await agent.post(`/api/assignments/${aId}/steal`);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not unlocked|too early|unlock/i);
});

test('steal returns 400 for school work', async () => {
  const db = freshDb();
  setUnlockMinutesAgo(db, 60);
  const owner = seedKid(db, 'Owner');
  const stealer = seedKid(db, 'Stealer');
  const cId = seedChore(db, 'Math', 3, 1); // school work
  const aId = seedAssignment(db, cId, owner);
  const app = freshApp(db);
  const agent = await loginKid(app, stealer);
  const res = await agent.post(`/api/assignments/${aId}/steal`);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /school/i);
});

test('steal returns 400 if assignment is not pending', async () => {
  const db = freshDb();
  setUnlockMinutesAgo(db, 60);
  const owner = seedKid(db, 'Owner');
  const stealer = seedKid(db, 'Stealer');
  const cId = seedChore(db, 'X', 3, 0);
  const aId = seedAssignment(db, cId, owner, 'done');
  const app = freshApp(db);
  const agent = await loginKid(app, stealer);
  const res = await agent.post(`/api/assignments/${aId}/steal`);
  assert.equal(res.status, 400);
});

test('steal returns 403 if caller is the current owner', async () => {
  const db = freshDb();
  setUnlockMinutesAgo(db, 60);
  const owner = seedKid(db, 'Owner');
  const cId = seedChore(db, 'X', 3, 0);
  const aId = seedAssignment(db, cId, owner);
  const app = freshApp(db);
  const agent = await loginKid(app, owner);
  const res = await agent.post(`/api/assignments/${aId}/steal`);
  assert.equal(res.status, 403);
});

test('GET /api/home includes stealable list for siblings post-unlock', async () => {
  const db = freshDb();
  setUnlockMinutesAgo(db, 60);
  const owner = seedKid(db, 'Owner');
  const stealer = seedKid(db, 'Stealer');
  const cId = seedChore(db, 'X', 3, 0);
  seedAssignment(db, cId, owner);

  const app = freshApp(db);
  const agent = await loginKid(app, stealer);
  const res = await agent.get('/api/home');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.stealable));
  assert.equal(res.body.stealable.length, 1);
  assert.equal(res.body.stealable[0].title, 'X');
  assert.equal(res.body.stealable[0].owner_name, 'Owner');
});

test('GET /api/home returns empty stealable list before unlock', async () => {
  const db = freshDb();
  setUnlockMinutesFromNow(db, 60);
  const owner = seedKid(db, 'Owner');
  const stealer = seedKid(db, 'Stealer');
  const cId = seedChore(db, 'X', 3, 0);
  seedAssignment(db, cId, owner);
  const app = freshApp(db);
  const agent = await loginKid(app, stealer);
  const res = await agent.get('/api/home');
  assert.equal(res.body.stealable.length, 0);
});

test('GET /api/home stealable excludes school work', async () => {
  const db = freshDb();
  setUnlockMinutesAgo(db, 60);
  const owner = seedKid(db, 'Owner');
  const stealer = seedKid(db, 'Stealer');
  const cId = seedChore(db, 'Math', 3, 1);
  seedAssignment(db, cId, owner);
  const app = freshApp(db);
  const agent = await loginKid(app, stealer);
  const res = await agent.get('/api/home');
  assert.equal(res.body.stealable.length, 0);
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL — `/steal` and `stealable` don't exist.

- [ ] **Step 3: Add the steal endpoint + stealable list to `src/routes/home.js`**

In `src/routes/home.js`, find the `homeRoutes` factory. Add a new helper function and the `/steal` route.

First, add this helper function at the bottom of the file (after `doSubmit`):

```js
function isUnlocked(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'steal_unlock_time'").get();
  if (!row) return false;
  const [hh, mm] = row.value.split(':').map(Number);
  const now = new Date();
  const cutoff = new Date();
  cutoff.setHours(hh, mm, 0, 0);
  return now >= cutoff;
}
```

Next, inside the GET /home handler, just BEFORE `res.json(...)`, build a stealable list:

```js
    const stealable = isUnlocked(db) ? db.prepare(`
      SELECT a.id, c.title, c.weight, c.anti_cheat,
             a.person_id AS owner_id,
             p.name AS owner_name,
             p.avatar_color AS owner_color
      FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      JOIN people p ON p.id = a.person_id
      WHERE a.due_date = ?
        AND a.status = 'pending'
        AND a.person_id != ?
        AND p.role = 'kid'
        AND c.is_school_work = 0
      ORDER BY p.name, c.title
    `).all(today(), personId) : [];
    for (const s of stealable) {
      s.display_points = pts.totalWeight > 0
        ? Math.round(s.weight / pts.totalWeight * target)
        : (person.weekly_target_pts > 0 ? Math.round(s.weight / 5 * person.weekly_target_pts / 10) : s.weight);
    }
```

And include `stealable` in the response:

```js
    res.json({ person, today: todayList, overdue: overdueList, stealable });
```

Now add the new route inside `homeRoutes`, after the existing `/assignments/:id/submit`:

```js
  r.post('/assignments/:id/steal', requireRole('kid'), (req, res) => {
    const db = req.app.get('db');
    const stealerId = req.user.person_id;
    const a = db.prepare(`
      SELECT a.*, c.is_school_work
      FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      WHERE a.id = ?
    `).get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.person_id === stealerId) return res.status(403).json({ error: 'Cannot steal from yourself' });
    if (a.is_school_work) return res.status(400).json({ error: 'School work cannot be stolen' });
    if (a.status !== 'pending') return res.status(400).json({ error: 'Only pending chores can be stolen' });
    if (a.due_date !== today()) return res.status(400).json({ error: 'Only today\'s chores can be stolen' });
    if (!isUnlocked(db)) return res.status(400).json({ error: 'Stealing is not yet unlocked today' });

    const result = db.prepare(`
      UPDATE assignments
      SET person_id = ?, stolen_from = ?, updated_at = datetime('now')
      WHERE id = ?
        AND status = 'pending'
        AND person_id = ?
    `).run(stealerId, a.person_id, req.params.id, a.person_id);

    if (result.changes === 0) {
      return res.status(409).json({ error: 'Already claimed or no longer pending' });
    }
    res.json({ ok: true });
  });
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 82 tests (74 prior + 8 new).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/routes/home.js tests/routes-steal.test.js && git commit -m "feat(steal): POST /assignments/:id/steal + stealable list in /home"
```

---

## Task 10: Admin Chore modal: weight select + school checkbox

**Files:**
- Modify: `public/js/pages/admin.js`

- [ ] **Step 1: Read the current `editChore` function**

Use Read to inspect `public/js/pages/admin.js` lines around `editChore` (approximately line 220-280, depending on prior edits). It currently builds a form with title, points, recurs, days, anti_cheat, assigned-to.

- [ ] **Step 2: Modify `editChore` to add Weight and School fields**

Find the `data` initialization block in `editChore`:

```js
  const data = chore ? { ...chore } : {
    title: '', points: 5, kind: 'recurring', recurs: 'daily', anti_cheat: 'honor',
    default_assignees: '', recurs_days: '',
  };
```

Replace with:

```js
  const data = chore ? { ...chore } : {
    title: '', points: 5, weight: 3, is_school_work: 0,
    kind: 'recurring', recurs: 'daily', anti_cheat: 'honor',
    default_assignees: '', recurs_days: '',
  };
```

Then find the `fields` array (which contains form-field els). Just BEFORE the existing `Recurs` field, INSERT these two new fields:

```js
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Weight (effort)']),
      el('select', { onChange: e => data.weight = Number(e.target.value) },
        [1,2,3,4,5].map(w => el('option', { value: w, selected: data.weight === w }, [String(w) + (w === 1 ? ' — very light' : w === 5 ? ' — very heavy' : '')]))
      ),
    ]),
    el('div', { class: 'form-field' }, [
      el('label', { class: 'row', style: { gap: '6px', cursor: 'pointer' } }, [
        el('input', {
          type: 'checkbox',
          checked: data.is_school_work === 1,
          onChange: e => { data.is_school_work = e.target.checked ? 1 : 0; },
        }),
        el('span', {}, ['School work — cannot be stolen by siblings']),
      ]),
    ]),
```

- [ ] **Step 3: Show weight dots in the Chores list row**

Find the `renderChores` function. In the `rows` builder block, find the meta line:

```js
        el('div', { class: 'muted', style: { fontSize: '0.78rem' } }, [
          `${c.recurs} · ${c.anti_cheat} · ${c.points} pts`
        ]),
```

Replace with:

```js
        el('div', { class: 'muted', style: { fontSize: '0.78rem' } }, [
          `${c.recurs} · ${c.anti_cheat} · weight ${'●'.repeat(c.weight || 3)}${'○'.repeat(5 - (c.weight || 3))}${c.is_school_work ? ' · 📚 school' : ''}`,
        ]),
```

Note: we ARE using an emoji here for one specific informational marker. The user has preferences against emoji generally but accepted indicators on the wall display previously. If this is rejected, replace `📚 school` with `[school]` plain text.

Actually safer: use `(school)` plain text per the user's no-emoji preference. Final:

```js
        el('div', { class: 'muted', style: { fontSize: '0.78rem' } }, [
          `${c.recurs} · ${c.anti_cheat} · weight ${'●'.repeat(c.weight || 3)}${'○'.repeat(5 - (c.weight || 3))}${c.is_school_work ? ' · (school)' : ''}`,
        ]),
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — still 82 tests (no new tests, pure UI).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/admin.js && git commit -m "feat(admin/chores): weight select + school-work checkbox in modal + visual dots"
```

---

## Task 11: Admin Settings tab

**Files:**
- Modify: `public/js/pages/admin.js`, `public/css/layouts.css`

- [ ] **Step 1: Add the Settings tab to `TABS` in `public/js/pages/admin.js`**

Find the TABS declaration at the top of the file:

```js
const TABS = [
  { key: 'today',      label: 'Today',      render: renderToday },
  { key: 'day-review', label: 'Day review', render: renderDayReview },
  { key: 'approvals',  label: 'Approvals',  render: renderApprovals },
  { key: 'people',     label: 'People',     render: renderPeople },
  { key: 'chores',     label: 'Chores',     render: renderChores },
];
```

Append the Settings entry:

```js
const TABS = [
  { key: 'today',      label: 'Today',      render: renderToday },
  { key: 'day-review', label: 'Day review', render: renderDayReview },
  { key: 'approvals',  label: 'Approvals',  render: renderApprovals },
  { key: 'people',     label: 'People',     render: renderPeople },
  { key: 'chores',     label: 'Chores',     render: renderChores },
  { key: 'settings',   label: 'Settings',   render: renderSettings },
];
```

- [ ] **Step 2: Append `renderSettings` to the end of `public/js/pages/admin.js`**

```js
/* ───── Settings tab ───── */
async function renderSettings(host) {
  clear(host);
  const data = await api.get('/api/admin/settings');
  const s = data.settings;

  host.appendChild(el('h3', { style: { marginBottom: 'var(--s4)' } }, ['Settings']));

  const stealField = el('div', { class: 'form-field' }, [
    el('label', {}, ['Steal unlock time (24-hour local)']),
    el('input', {
      type: 'time',
      value: s.steal_unlock_time || '16:00',
      onChange: async (e) => {
        const value = e.target.value;
        try {
          await api.patch('/api/admin/settings/steal_unlock_time', { value });
          e.target.style.borderColor = 'var(--green)';
          setTimeout(() => { e.target.style.borderColor = ''; }, 800);
        } catch (err) {
          alert('Save failed: ' + err.message);
        }
      },
    }),
    el('div', { class: 'muted', style: { fontSize: '0.78rem', marginTop: '4px' } }, [
      'Time of day after which kids can claim siblings\' pending non-school chores.',
    ]),
  ]);

  host.appendChild(stealField);
}
```

- [ ] **Step 3: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — still 82 tests.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/admin.js && git commit -m "feat(admin): Settings tab with steal_unlock_time input"
```

---

## Task 12: Kid home — dynamic points + projected pay + Steal section

**Files:**
- Modify: `public/js/pages/home.js`, `public/css/layouts.css`

- [ ] **Step 1: Read the current `public/js/pages/home.js`** to understand the existing structure (renderHome, renderTask).

- [ ] **Step 2: Update `renderHome` in `public/js/pages/home.js`**

The current `heroProgress` calculation reads `p.points_this_week`. Now `points_this_week` and `percent` come from the server. Replace the existing hero card construction with:

Find:

```js
  const heroProgress = p.weekly_target_pts > 0
    ? Math.min(100, Math.round(((p.points_this_week || 0) / p.weekly_target_pts) * 100))
    : 0;

  const hero = el('div', { class: 'hero' }, [
    el('div', { class: 'label' }, ['This week']),
    el('div', { class: 'big-num' }, [
      el('span', {}, [String(p.points_this_week || 0)]),
      el('span', { class: 'denom' }, [` / ${p.weekly_target_pts} pts`]),
    ]),
    el('div', { class: 'bar' }, [el('div', { class: 'bar-fill', style: { width: heroProgress + '%' } })]),
    el('div', { class: 'row spaced', style: { marginTop: '10px', fontSize: '0.78rem', color: 'var(--hero-muted)' } }, [
      el('span', {}, [`${p.streak_days || 0} day streak`]),
      el('span', {}, [`$${((p.bank_cents || 0) / 100).toFixed(2)} bank`]),
    ]),
  ]);
```

Replace with:

```js
  const pct = Math.min(100, Math.round((p.percent || 0) * 100));
  const points = p.points_this_week || 0;
  const target = p.weekly_target_pts || 0;
  const projDollars = ((p.projected_pay_cents || 0) / 100).toFixed(2);

  const hero = el('div', { class: 'hero' }, [
    el('div', { class: 'label' }, ['This week']),
    el('div', { class: 'big-num' }, [
      el('span', {}, [String(points)]),
      el('span', { class: 'denom' }, [` / ${target} pts · ${pct}%`]),
    ]),
    el('div', { class: 'bar' }, [el('div', { class: 'bar-fill', style: { width: pct + '%' } })]),
    el('div', { class: 'row spaced', style: { marginTop: '10px', fontSize: '0.78rem', color: 'var(--hero-muted)' } }, [
      el('span', {}, [`~$${projDollars} projected`]),
      el('span', {}, [`${p.streak_days || 0} day streak`]),
    ]),
  ]);
```

- [ ] **Step 3: Update `renderTask` to use `display_points` and show "stolen from" badge**

Find the function in the same file. Update the places that show `+${a.points}` to use `+${a.display_points}` (since server now sends display_points instead of relying on points). Three locations in renderTask use `a.points` — change them all to `a.display_points`.

Specifically, in the action variable block, change:

- `action = el('span', { class: 'pts' }, [`+${a.points}`]);` → `action = el('span', { class: 'pts' }, [`+${a.display_points}`]);`
- `Done · +${a.points}` → `Done · +${a.display_points}`
- `Submit · +${a.points}` → `Submit · +${a.display_points}`
- `Photo · +${a.points}` → `Photo · +${a.display_points}`
- `Undo · +${a.points}` → `Undo · +${a.display_points}`

And in renderTask, just before the return statement, build a stolen-from indicator:

```js
  const stolenBadge = a.stolen_from_name
    ? el('span', { class: 'pill pill-info', style: { fontSize: '0.62rem' } }, [`↻ from ${a.stolen_from_name}`])
    : null;
```

Update the return to include this badge in the row's left side:

```js
  return el('div', { class: classes.join(' ') }, [
    el('div', { class: 'left' }, [
      el('div', { class: `ico ${ico}` }, [icoText]),
      el('div', {}, [
        el('div', {}, [a.title]),
        stolenBadge,
      ].filter(Boolean)),
    ]),
    action,
  ]);
```

- [ ] **Step 4: Add the Steal section to renderHome**

In `renderHome`, after the `overdueSection` line and before the `root.appendChild(el('div', { class: 'page stack' }, [...]))` line, add:

```js
  const stealSection = (data.stealable && data.stealable.length > 0)
    ? el('section', { class: 'stack' }, [
        el('div', { class: 'label' }, ['Steal from a sibling']),
        ...data.stealable.map(s => el('div', { class: 'txn steal-row' }, [
          el('div', { class: 'left' }, [
            el('div', { class: 'chip', style: { background: s.owner_color || '#0F172A' } }, [s.owner_name[0]]),
            el('div', {}, [
              el('div', {}, [s.title]),
              el('div', { class: 'muted', style: { fontSize: '0.7rem' } }, [s.owner_name]),
            ]),
          ]),
          el('button', {
            class: 'btn btn-primary btn-done',
            onClick: async (e) => {
              e.stopPropagation();
              e.target.disabled = true;
              e.target.textContent = '…';
              try {
                await api.post(`/api/assignments/${s.id}/steal`);
                renderHome(root);
              } catch (err) {
                alert('Could not claim: ' + err.message);
                e.target.disabled = false;
                e.target.textContent = `Claim · +${s.display_points}`;
              }
            },
          }, [`Claim · +${s.display_points}`]),
        ])),
      ])
    : null;
```

Then update the root.appendChild list to include `stealSection` between `overdueSection` and the sign-out row:

Find:

```js
  root.appendChild(el('div', { class: 'page stack' }, [
    el('header', { class: 'app-header' }, [
      el('h1', {}, [`Hey ${p.name}`]),
      el('div', { class: 'av', style: { background: p.avatar_color } }, [p.name[0]]),
    ]),
    hero,
    todaySection,
    overdueSection,
    el('div', { class: 'row', style: { marginTop: 'var(--s5)' } }, [
      el('button', { class: 'btn btn-ghost', onClick: () => logout() }, ['Sign out']),
    ]),
  ].filter(Boolean)));
```

Replace with:

```js
  root.appendChild(el('div', { class: 'page stack' }, [
    el('header', { class: 'app-header' }, [
      el('h1', {}, [`Hey ${p.name}`]),
      el('div', { class: 'av', style: { background: p.avatar_color } }, [p.name[0]]),
    ]),
    hero,
    todaySection,
    overdueSection,
    stealSection,
    el('div', { class: 'row', style: { marginTop: 'var(--s5)' } }, [
      el('button', { class: 'btn btn-ghost', onClick: () => logout() }, ['Sign out']),
    ]),
  ].filter(Boolean)));
```

- [ ] **Step 5: Append a small CSS rule** to `public/css/layouts.css`:

```css
.steal-row {
  border-style: dashed;
  background: linear-gradient(0deg, var(--card-muted), var(--card));
}
```

- [ ] **Step 6: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 82 tests.

- [ ] **Step 7: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/home.js public/css/layouts.css && git commit -m "feat(home): live points + projected pay + Steal section + stolen-from badge"
```

---

## Task 13: Wall display — per-kid points/percent + stolen badge

**Files:**
- Modify: `public/js/pages/wall.js`

- [ ] **Step 1: Read the current `public/js/pages/wall.js`** to understand the existing kid column structure.

- [ ] **Step 2: Update wall.js to show points/percent + stolen badge**

Find the column rendering loop in `render()` where each kid's column is built. The meta line currently looks like:

```js
        el('div', { class: 'meta' }, [
          el('span', {}, [`target ${k.weekly_target_pts || 0} pts`]),
          el('span', {}, [`${k.streak_days || 0}d streak`]),
        ]),
```

Replace with:

```js
        el('div', { class: 'meta' }, [
          el('span', {}, [`${k.points || 0} pts (${Math.round((k.percent || 0) * 100)}%)`]),
          el('span', {}, [`${k.streak_days || 0}d streak`]),
        ]),
```

Then find the task rendering inside the kid column:

```js
            : tasks.map(t => el('div', {
                class: 'task' + (t.status === 'done' ? ' done' : '') + (t.over ? ' over' : ''),
              }, [
                el('span', {}, [t.title]),
                el('span', { class: 'p' }, [`+${t.points}`]),
              ]))
```

Replace with:

```js
            : tasks.map(t => el('div', {
                class: 'task' + (t.status === 'done' ? ' done' : '') + (t.over ? ' over' : ''),
              }, [
                el('div', {}, [
                  el('span', {}, [t.title]),
                  t.stolen_from_name ? el('span', { style: { fontSize: '0.62rem', color: 'var(--muted)', marginLeft: '6px' } }, [`(↻ ${t.stolen_from_name})`]) : null,
                ].filter(Boolean)),
                el('span', { class: 'p' }, [`+${t.display_points || 0}`]),
              ]))
```

- [ ] **Step 3: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 82 tests.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/wall.js && git commit -m "feat(wall): per-kid points + percent + stolen-from badge on tasks"
```

---

## Task 14: End-to-end smoke + deploy + tag

- [ ] **Step 1: Final full test run**

```bash
cd ~/projects/tally && npm test
```

Expected: 82 tests pass.

- [ ] **Step 2: PM2 reload on production**

```bash
cd ~/projects/tally && pm2 reload tally
sleep 3
curl -sf --resolve tally.thelopezfamily.org:443:104.21.49.63 https://tally.thelopezfamily.org/api/health
```

Expected: `{"ok":true}`.

- [ ] **Step 3: Manual smoke test (instructions for the user)**

Open https://tally.thelopezfamily.org/ and:

1. As parent: visit Admin → Chores → edit "Mow lawn" (or any heavy chore) → set Weight = 5, save.
2. As parent: visit Admin → Chores → edit "Make bed" → set Weight = 1, save.
3. As parent: visit Admin → Settings → set Steal unlock time to current time minus 1 minute.
4. Sign out → sign in as Olivia.
5. Hero card should now show real points and percent (not 0).
6. Open the kid home for Christopher in a separate browser; verify the Steal section shows Olivia's pending non-school chores after the unlock time.
7. Christopher claims one. It moves to his Today list with a ↻ badge. Olivia's home loses it.
8. Christopher completes it → his hero card percent goes over 100% if he had all his own done.

- [ ] **Step 4: Tag the release**

```bash
cd ~/projects/tally && git tag v0.2.0-phase2a && git log --oneline -15
```

- [ ] **Step 5: Commit any final cleanup**

If there's a final commit needed (none expected), make it. Otherwise just verify state:

```bash
cd ~/projects/tally && git status
```

Expected: clean tree, no uncommitted changes.

---

## Self-Review

**Spec coverage check (§ markers from spec):**

| Spec section | Covered by Task(s) |
|---|---|
| §2 Goals | Whole plan |
| §3 Non-goals | Honored (no ledger writes, no settle UI, no bank) |
| §4 Point math | Tasks 2 (lib), 3 (home), 5 (wall), 6 (admin/today) |
| §5 Payment math | Task 2 (calcProjectedPay), Tasks 3 + 6 (surface) |
| §6 Stealing endpoint + rules | Task 9 |
| §6 Stealing UI surface | Task 12 (kid steal section, stolen badge), Task 13 (wall stolen badge) |
| §7 Schema | Task 1 |
| §8 API: new + modified payloads | Tasks 3, 5, 6, 9 |
| §8 src/lib/points.js | Task 2 |
| §9 Admin chore modal weight + school | Task 10 |
| §9 Admin Settings tab | Tasks 8 (backend) + 11 (frontend) |
| §9 Kid hero card + projected pay | Task 12 |
| §9 Wall display | Task 13 |
| §10 Tech notes | Implementation details throughout |
| §11 Build phases | Tasks roughly map 1:1 |
| §12 Acceptance test | Task 14 step 3 |

**Placeholder scan:** Re-read each task. Every step has runnable code or commands. No TBDs. The one "actually safer" inline edit decision in Task 10 (school marker) commits to `(school)` plain text, not the emoji.

**Type consistency:**
- `calcWeekPoints` signature `(db, personId, weekStartIso)` used identically in Tasks 2/3/5/6
- `calcProjectedPay(person, points)` returns cents — used as cents throughout
- Field names: `points_this_week`, `percent`, `projected_pay_cents`, `display_points`, `stolen_from`, `stolen_from_name` used consistently
- `is_school_work` 0/1 integer (not boolean) — consistent everywhere

Plan is internally consistent and complete.

---

## Execution Handoff

Plan complete and saved to [`docs/superpowers/plans/2026-05-26-tally-phase-2a-implementation.md`](2026-05-26-tally-phase-2a-implementation.md). 14 tasks total. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task with two-stage review, no context pollution, fast iteration.

**2. Inline Execution** — work through it in this session with checkpoints.

Which approach?
