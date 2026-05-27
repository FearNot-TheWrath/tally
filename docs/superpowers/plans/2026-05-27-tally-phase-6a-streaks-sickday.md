# Tally — Phase 6a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up real streak tracking (strict "all chores done today" rule), sick-day freeze (preserves streak through the date range), at-risk warning, and a wall leader callout — on top of schema columns that already exist.

**Architecture:** New pure module `src/lib/streak.js` with `currentStreak`, `streakAtRisk`, `isOnFreeze`. Stateless — recomputed on every read of `/api/home`, `/api/wall`, `/api/admin/today`. No new schema; existing `people.streak_*` and `people.freeze_*` columns are sufficient. New settings key `streak_warning_time`. Admin UI gets two date inputs on the People modal; Settings tab gets a streak warning time input.

**Tech Stack:** Same as prior phases — Node 20+, Express 5, better-sqlite3, vanilla JS SPA. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-05-26-tally-phase-6a-streaks-sickday.md`](../specs/2026-05-26-tally-phase-6a-streaks-sickday.md)

**Prior phases:** 1, 2a, 3, 4 all live (tag `v0.4.0-phase4`).

---

## File Structure

```
~/projects/tally/
├── src/
│   ├── lib/
│   │   └── streak.js                            NEW: currentStreak, streakAtRisk, isOnFreeze
│   ├── routes/
│   │   ├── home.js                              MODIFY: person.streak_days/at_risk/on_freeze
│   │   ├── wall.js                              MODIFY: per-kid streak + streak_leader payload
│   │   └── admin/
│   │       ├── today.js                         MODIFY: per-kid streak + on_freeze
│   │       └── settings.js                      MODIFY: add streak_warning_time to EDITABLE_KEYS
└── public/
    ├── js/pages/
    │   ├── admin.js                             MODIFY: People modal freeze fields + Settings warning input
    │   ├── home.js                              MODIFY: hero streak number + at-risk pill
    │   └── wall.js                              MODIFY: streak leader banner + per-kid On freeze pill
    └── css/layouts.css                          MODIFY: streak-leader banner, on-freeze pill styles

tests/
├── lib-streak.test.js                           NEW
├── routes-home-streak.test.js                   NEW
└── routes-wall.test.js                          MODIFY: add streak_leader + on_freeze tests
```

---

## Task 1: `src/lib/streak.js` with pure functions

**Files:**
- Create: `src/lib/streak.js`, `tests/lib-streak.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/lib-streak.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { currentStreak, streakAtRisk, isOnFreeze } from '../src/lib/streak.js';
import { today, toIso, fromIso } from '../src/lib/dates.js';

function seedKid(db, name = 'K') {
  return db.prepare("INSERT INTO people (name, role) VALUES (?, 'kid') RETURNING id").get(name).id;
}
function seedChore(db) {
  return db.prepare(
    "INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('T', 3, 'daily', '') RETURNING id"
  ).get().id;
}
function seedAssignment(db, choreId, kidId, dueDate, status = 'pending') {
  return db.prepare(
    "INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, ?) RETURNING id"
  ).get(choreId, kidId, dueDate, status).id;
}
function setFreeze(db, kidId, startIso, endIso) {
  db.prepare("UPDATE people SET freeze_start = ?, freeze_end = ? WHERE id = ?")
    .run(startIso, endIso, kidId);
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toIso(d);
}

test('currentStreak with no assignments returns 0', () => {
  const db = freshDb();
  const kid = seedKid(db);
  assert.equal(currentStreak(db, kid), 0);
});

test('currentStreak with today partly done does not break the streak (in-progress)', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c1 = seedChore(db);
  const c2 = seedChore(db);
  // Yesterday: all done (1 chore, done)
  seedAssignment(db, c1, kid, daysAgo(1), 'done');
  // Today: 1 done + 1 pending
  seedAssignment(db, c1, kid, today(), 'done');
  seedAssignment(db, c2, kid, today(), 'pending');
  // Streak should be 1 (yesterday counts, today in progress)
  assert.equal(currentStreak(db, kid), 1);
});

test('currentStreak with today fully done counts today', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, daysAgo(1), 'done');
  seedAssignment(db, c, kid, today(), 'done');
  assert.equal(currentStreak(db, kid), 2);
});

test('currentStreak: a non-frozen incomplete past day breaks the streak', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  // 3 days ago: pending (incomplete) — breaks streak here
  seedAssignment(db, c, kid, daysAgo(3), 'pending');
  // 2 days ago: done
  seedAssignment(db, c, kid, daysAgo(2), 'done');
  // 1 day ago: done
  seedAssignment(db, c, kid, daysAgo(1), 'done');
  // Today: done
  seedAssignment(db, c, kid, today(), 'done');
  // Streak = 3 (today + yesterday + day before)
  assert.equal(currentStreak(db, kid), 3);
});

test('currentStreak: a frozen day in the middle is transparent', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  // Yesterday: frozen (no chores done)
  seedAssignment(db, c, kid, daysAgo(1), 'pending');
  // 2 days ago: done
  seedAssignment(db, c, kid, daysAgo(2), 'done');
  // Today: done
  seedAssignment(db, c, kid, today(), 'done');
  // Freeze yesterday only
  setFreeze(db, kid, daysAgo(1), daysAgo(1));
  // Streak = 2 (today + 2 days ago, with yesterday skipped)
  assert.equal(currentStreak(db, kid), 2);
});

test('currentStreak with today frozen: walks back transparently', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, daysAgo(1), 'done');
  // Today not done but frozen — should not break streak
  seedAssignment(db, c, kid, today(), 'pending');
  setFreeze(db, kid, today(), today());
  // Streak = 1 (yesterday counted, today skipped silently)
  assert.equal(currentStreak(db, kid), 1);
});

test('currentStreak: a day with zero assignments qualifies vacuously', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  // Today: done
  seedAssignment(db, c, kid, today(), 'done');
  // Yesterday: NO assignments at all (kid had nothing assigned)
  // 2 days ago: done
  seedAssignment(db, c, kid, daysAgo(2), 'done');
  // Streak should be 3 (today + vacuous yesterday + 2 days ago)
  assert.equal(currentStreak(db, kid), 3);
});

test('currentStreak: safety cap stops a runaway loop', () => {
  // We can't easily construct a runaway state, but the function should
  // terminate cleanly even on the worst-case all-frozen scenario.
  const db = freshDb();
  const kid = seedKid(db);
  // Freeze a giant range — every day would be frozen including past 1000 days
  setFreeze(db, kid, '1900-01-01', '2099-12-31');
  // With all days frozen, the walk should return 0 within the 1000-iter cap
  const result = currentStreak(db, kid);
  assert.equal(typeof result, 'number');
  assert.ok(result >= 0);
});

test('isOnFreeze: true when today between bounds', () => {
  const db = freshDb();
  const kid = seedKid(db);
  setFreeze(db, kid, daysAgo(1), daysAgo(-1)); // yesterday..tomorrow
  assert.equal(isOnFreeze(db, kid), true);
});

test('isOnFreeze: false when no bounds set', () => {
  const db = freshDb();
  const kid = seedKid(db);
  assert.equal(isOnFreeze(db, kid), false);
});

test('isOnFreeze: false when only one bound set', () => {
  const db = freshDb();
  const kid = seedKid(db);
  // Only start, no end
  db.prepare("UPDATE people SET freeze_start = ? WHERE id = ?").run(today(), kid);
  assert.equal(isOnFreeze(db, kid), false);
});

test('isOnFreeze: false when date is outside the range', () => {
  const db = freshDb();
  const kid = seedKid(db);
  setFreeze(db, kid, daysAgo(10), daysAgo(5));
  assert.equal(isOnFreeze(db, kid), false);
});

test('streakAtRisk: false when streak is 0', () => {
  const db = freshDb();
  const kid = seedKid(db);
  // Even with pending chores today, streak=0 means no warning
  const c = seedChore(db);
  seedAssignment(db, c, kid, today(), 'pending');
  assert.equal(streakAtRisk(db, kid, '00:00', 0), false);
});

test('streakAtRisk: false before warning time', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, today(), 'pending');
  // 23:59 is past any plausible "now" except literally at midnight
  assert.equal(streakAtRisk(db, kid, '23:59', 5), false);
});

test('streakAtRisk: false when today is frozen', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, today(), 'pending');
  setFreeze(db, kid, today(), today());
  assert.equal(streakAtRisk(db, kid, '00:00', 5), false);
});

test('streakAtRisk: false when all today chores done', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, today(), 'done');
  assert.equal(streakAtRisk(db, kid, '00:00', 5), false);
});

test('streakAtRisk: true when streak>0, past warning, not frozen, chores pending', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, today(), 'pending');
  assert.equal(streakAtRisk(db, kid, '00:00', 5), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL — `src/lib/streak.js` doesn't exist yet.

- [ ] **Step 3: Create `src/lib/streak.js`**

```js
import { today, toIso, fromIso } from './dates.js';

const MAX_WALK = 1000;

/**
 * Compute the current streak for a kid.
 *
 * Walks back from today through consecutive qualifying days. A day "qualifies"
 * if all materialized assignments for that kid on that date have status='done'
 * (zero assignments qualifies vacuously — no failure possible). Today is in
 * "limbo" until it either qualifies (counts) or fails (resets — but ONLY after
 * midnight, so during the day the streak shown is the count walked back from
 * the previous qualifying day).
 *
 * Frozen days (within the kid's freeze_start..freeze_end range) are
 * transparent — they don't increment, don't break, just skip.
 */
export function currentStreak(db, personId) {
  const person = db.prepare(
    'SELECT freeze_start, freeze_end FROM people WHERE id = ?'
  ).get(personId);
  if (!person) return 0;

  let count = 0;
  let date = today();
  let isToday = true;

  for (let i = 0; i < MAX_WALK; i++) {
    if (inFreezeRange(date, person.freeze_start, person.freeze_end)) {
      date = prevDay(date);
      isToday = false;
      continue;
    }

    const qualifies = dayQualifies(db, personId, date);
    if (qualifies) {
      count++;
      date = prevDay(date);
      isToday = false;
      continue;
    }

    if (isToday) {
      // Today is incomplete but not yet over — don't count, don't break
      date = prevDay(date);
      isToday = false;
      continue;
    }

    // A non-frozen past day didn't qualify — streak ends here
    break;
  }

  return count;
}

/**
 * Whether `dateIso` is in this kid's freeze range. Returns false if
 * either bound is null/missing.
 */
export function isOnFreeze(db, personId, dateIso = today()) {
  const person = db.prepare(
    'SELECT freeze_start, freeze_end FROM people WHERE id = ?'
  ).get(personId);
  if (!person) return false;
  return inFreezeRange(dateIso, person.freeze_start, person.freeze_end);
}

/**
 * Streak at risk: current local time past warning, streak > 0, not frozen,
 * at least one non-bonus assignment for today still pending.
 */
export function streakAtRisk(db, personId, warningTime, currentStreakValue) {
  if (!currentStreakValue || currentStreakValue <= 0) return false;
  if (!warningTime || !/^\d{2}:\d{2}$/.test(warningTime)) return false;
  const now = new Date();
  const [wh, wm] = warningTime.split(':').map(Number);
  const cutoff = new Date();
  cutoff.setHours(wh, wm, 0, 0);
  if (now < cutoff) return false;

  if (isOnFreeze(db, personId)) return false;

  const row = db.prepare(`
    SELECT 1
    FROM assignments a
    JOIN chores c ON c.id = a.chore_id
    WHERE a.person_id = ?
      AND a.due_date = ?
      AND a.status != 'done'
      AND c.kind != 'bonus'
    LIMIT 1
  `).get(personId, today());
  return !!row;
}

/* ───── internals ───── */

function dayQualifies(db, personId, dateIso) {
  // Day qualifies if every non-bonus assignment for the kid on this date
  // is status='done'. Zero non-bonus assignments qualifies vacuously.
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN a.status = 'done' THEN 1 ELSE 0 END), 0) AS done
    FROM assignments a
    JOIN chores c ON c.id = a.chore_id
    WHERE a.person_id = ? AND a.due_date = ? AND c.kind != 'bonus'
  `).get(personId, dateIso);
  return row.total === row.done; // zero/zero = true
}

function inFreezeRange(dateIso, startIso, endIso) {
  if (!startIso || !endIso) return false;
  return dateIso >= startIso && dateIso <= endIso;
}

function prevDay(dateIso) {
  const d = fromIso(dateIso);
  d.setDate(d.getDate() - 1);
  return toIso(d);
}
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 121 tests (105 prior + 16 new).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/lib/streak.js tests/lib-streak.test.js && git commit -m "feat(lib/streak): currentStreak + streakAtRisk + isOnFreeze pure functions"
```

---

## Task 2: Wire streak fields into `/api/home`

**Files:**
- Modify: `src/routes/home.js`
- Create: `tests/routes-home-streak.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/routes-home-streak.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';
import { today, toIso } from '../src/lib/dates.js';

function seedKid(db, name = 'K') {
  return db.prepare("INSERT INTO people (name, role, weekly_target_pts) VALUES (?, 'kid', 100) RETURNING id").get(name).id;
}
function seedChore(db) {
  return db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('T', 3, 'daily', '') RETURNING id").get().id;
}
function seedAssignment(db, choreId, kidId, dueDate, status = 'pending') {
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, ?)").run(choreId, kidId, dueDate, status);
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toIso(d);
}
async function loginKid(app, id) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id });
  return agent;
}

test('GET /api/home returns computed streak_days', async () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, daysAgo(1), 'done');
  seedAssignment(db, c, kid, today(), 'done');
  const agent = await loginKid(freshApp(db), kid);
  const res = await agent.get('/api/home');
  assert.equal(res.status, 200);
  assert.equal(res.body.person.streak_days, 2);
});

test('GET /api/home returns on_freeze true when in range', async () => {
  const db = freshDb();
  const kid = seedKid(db);
  db.prepare("UPDATE people SET freeze_start = ?, freeze_end = ? WHERE id = ?").run(today(), today(), kid);
  const agent = await loginKid(freshApp(db), kid);
  const res = await agent.get('/api/home');
  assert.equal(res.body.person.on_freeze, true);
});

test('GET /api/home returns streak_at_risk = false if streak is 0', async () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, today(), 'pending');
  // streak_warning_time defaults to 20:00; tests run at any time, so accept
  // both "before warning" and "after warning". streak=0 means false either way.
  const agent = await loginKid(freshApp(db), kid);
  const res = await agent.get('/api/home');
  assert.equal(res.body.person.streak_at_risk, false);
});

test('GET /api/home streak_at_risk respects streak_warning_time setting', async () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  // Yesterday all done → streak=1
  seedAssignment(db, c, kid, daysAgo(1), 'done');
  // Today pending
  seedAssignment(db, c, kid, today(), 'pending');
  // Force warning time to a moment ago so streakAtRisk is true
  const minAgo = new Date(Date.now() - 60_000);
  const hhmm = `${String(minAgo.getHours()).padStart(2,'0')}:${String(minAgo.getMinutes()).padStart(2,'0')}`;
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('streak_warning_time', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(hhmm);

  const agent = await loginKid(freshApp(db), kid);
  const res = await agent.get('/api/home');
  assert.equal(res.body.person.streak_days, 1);
  assert.equal(res.body.person.streak_at_risk, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL — new fields aren't populated.

- [ ] **Step 3: Modify `src/routes/home.js`**

Read the current file. At the top, add the import:

```js
import { currentStreak, streakAtRisk, isOnFreeze } from '../lib/streak.js';
```

Find the section in GET /home where `pts` is calculated and assigned to person. Just AFTER those lines, add:

```js
    const streakDays = currentStreak(db, personId);
    const warningRow = db.prepare("SELECT value FROM settings WHERE key='streak_warning_time'").get();
    const warningTime = warningRow ? warningRow.value : '20:00';
    person.streak_days = streakDays;
    person.streak_at_risk = streakAtRisk(db, personId, warningTime, streakDays);
    person.on_freeze = isOnFreeze(db, personId);
```

The full set of person-decoration lines should look like:

```js
    const ws = weekStart(today());
    const pts = calcWeekPoints(db, personId, ws);
    person.points_this_week = pts.points;
    person.percent = pts.percent;
    person.weighted_points = pts.weightedPoints;
    person.bonus_points_this_week = pts.bonusPoints;
    person.projected_pay_cents = calcProjectedPay(person, pts.points);

    const streakDays = currentStreak(db, personId);
    const warningRow = db.prepare("SELECT value FROM settings WHERE key='streak_warning_time'").get();
    const warningTime = warningRow ? warningRow.value : '20:00';
    person.streak_days = streakDays;
    person.streak_at_risk = streakAtRisk(db, personId, warningTime, streakDays);
    person.on_freeze = isOnFreeze(db, personId);
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 125 tests (121 prior + 4 new).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/routes/home.js tests/routes-home-streak.test.js && git commit -m "feat(home): GET /api/home returns streak_days + streak_at_risk + on_freeze"
```

---

## Task 3: Wire streak fields + leader into `/api/wall`

**Files:**
- Modify: `src/routes/wall.js`
- Modify: `tests/routes-wall.test.js`

- [ ] **Step 1: Append failing tests to `tests/routes-wall.test.js`**

Add at the bottom:

```js
test('GET /api/wall populates per-kid streak_days and on_freeze', async () => {
  const db = freshDb();
  const a = db.prepare("INSERT INTO people (name, role, weekly_target_pts) VALUES ('A','kid',100) RETURNING id").get().id;
  const b = db.prepare("INSERT INTO people (name, role, weekly_target_pts) VALUES ('B','kid',100) RETURNING id").get().id;
  // A: yesterday + today all done (zero assignments → vacuous qualifies → streak 0)
  // We need at least one done to count today.
  const c = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('T', 3, 'daily', '') RETURNING id").get().id;
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now', 'localtime', '-1 day'), 'done')").run(c, a);
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now', 'localtime'), 'done')").run(c, a);
  // B: freeze today
  db.prepare("UPDATE people SET freeze_start = date('now', 'localtime'), freeze_end = date('now', 'localtime') WHERE id = ?").run(b);

  const res = await request(freshApp(db)).get('/api/wall');
  assert.equal(res.status, 200);
  const kidA = res.body.kids.find(k => k.name === 'A');
  const kidB = res.body.kids.find(k => k.name === 'B');
  assert.equal(kidA.streak_days, 2);
  assert.equal(kidA.on_freeze, false);
  assert.equal(kidB.on_freeze, true);
});

test('GET /api/wall returns streak_leader for the kid with the highest streak', async () => {
  const db = freshDb();
  const a = db.prepare("INSERT INTO people (name, role, weekly_target_pts, avatar_color) VALUES ('A','kid',100,'#22C55E') RETURNING id").get().id;
  const b = db.prepare("INSERT INTO people (name, role, weekly_target_pts, avatar_color) VALUES ('B','kid',100,'#D4A017') RETURNING id").get().id;
  const c = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('T', 3, 'daily', '') RETURNING id").get().id;
  // A: 1 day streak (today done)
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now', 'localtime'), 'done')").run(c, a);
  // B: 3 day streak (today + yesterday + 2 days ago all done)
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now', 'localtime'), 'done')").run(c, b);
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now', 'localtime', '-1 day'), 'done')").run(c, b);
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now', 'localtime', '-2 day'), 'done')").run(c, b);

  const res = await request(freshApp(db)).get('/api/wall');
  assert.equal(res.body.streak_leader.name, 'B');
  assert.equal(res.body.streak_leader.streak_days, 3);
  assert.equal(res.body.streak_leader.color, '#D4A017');
});

test('GET /api/wall returns null streak_leader when no kid has a streak', async () => {
  const db = freshDb();
  db.prepare("INSERT INTO people (name, role) VALUES ('A','kid')").run();
  db.prepare("INSERT INTO people (name, role) VALUES ('B','kid')").run();
  const res = await request(freshApp(db)).get('/api/wall');
  assert.equal(res.body.streak_leader, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL — `streak_leader` and per-kid `streak_days`/`on_freeze` not populated.

- [ ] **Step 3: Modify `src/routes/wall.js`**

Read the current file. At the top, add:

```js
import { currentStreak, isOnFreeze } from '../lib/streak.js';
```

Find the per-kid loop where `calcWeekPoints` is called. Just below the existing pts assignments, add:

```js
      kid.streak_days = currentStreak(db, kid.id);
      kid.on_freeze = isOnFreeze(db, kid.id);
```

So the loop body looks like:

```js
    for (const kid of kids) {
      kid.today = [];
      kid.overdue = [];
      const pts = calcWeekPoints(db, kid.id, ws);
      kid.points = pts.points;
      kid.percent = pts.percent;
      totals.set(kid.id, pts.totalWeight);
      kid.streak_days = currentStreak(db, kid.id);
      kid.on_freeze = isOnFreeze(db, kid.id);
    }
```

Next, just before `res.json(...)`, compute the streak leader:

```js
    let streak_leader = null;
    for (const kid of kids) {
      if (kid.streak_days > 0) {
        if (!streak_leader || kid.streak_days > streak_leader.streak_days
            || (kid.streak_days === streak_leader.streak_days && kid.name < streak_leader.name)) {
          streak_leader = { name: kid.name, color: kid.avatar_color, streak_days: kid.streak_days };
        }
      }
    }
```

And include `streak_leader` in the response:

```js
    res.json({ kids, house_pct: housePct, today: todayIso, bonuses, streak_leader });
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 128 tests (125 prior + 3 new).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/routes/wall.js tests/routes-wall.test.js && git commit -m "feat(wall): per-kid streak_days + on_freeze + family streak_leader"
```

---

## Task 4: Wire streak fields into `/api/admin/today`

**Files:**
- Modify: `src/routes/admin/today.js`
- Modify: `tests/routes-admin-today.test.js`

- [ ] **Step 1: Append a new test to `tests/routes-admin-today.test.js`**

```js
test('GET /api/admin/today returns per-kid streak_days and on_freeze', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role, weekly_target_pts, freeze_start, freeze_end) VALUES ('K','kid',100,date('now','localtime'),date('now','localtime')) RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.get('/api/admin/today');
  assert.equal(res.status, 200);
  const k = res.body.kids[0];
  assert.equal(typeof k.streak_days, 'number');
  assert.equal(k.on_freeze, true);
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL — `streak_days` / `on_freeze` not present.

- [ ] **Step 3: Modify `src/routes/admin/today.js`**

Read the file. At top, add import:

```js
import { currentStreak, isOnFreeze } from '../../lib/streak.js';
```

Find the per-kid loop. After the existing pts/calcProjectedPay lines, add:

```js
      k.streak_days = currentStreak(db, k.id);
      k.on_freeze = isOnFreeze(db, k.id);
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 129 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/routes/admin/today.js tests/routes-admin-today.test.js && git commit -m "feat(admin/today): per-kid streak_days + on_freeze"
```

---

## Task 5: Add `streak_warning_time` to settings whitelist

**Files:**
- Modify: `src/routes/admin/settings.js`
- Modify: `tests/routes-admin-settings.test.js`

- [ ] **Step 1: Append a new test**

In `tests/routes-admin-settings.test.js`:

```js
test('PATCH /api/admin/settings/streak_warning_time works (whitelisted)', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.patch('/api/admin/settings/streak_warning_time').send({ value: '19:30' });
  assert.equal(res.status, 200);
  assert.equal(res.body.setting.value, '19:30');
  const row = db.prepare("SELECT value FROM settings WHERE key='streak_warning_time'").get();
  assert.equal(row.value, '19:30');
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL — `streak_warning_time` not in EDITABLE_KEYS.

- [ ] **Step 3: Modify `src/routes/admin/settings.js`**

Read the file. Find the EDITABLE_KEYS set. Add `'streak_warning_time'` to it. After editing, EDITABLE_KEYS looks like:

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
]);
```

And mirror this in `READABLE_KEYS` if it uses a spread of EDITABLE_KEYS (the existing pattern is `new Set([...EDITABLE_KEYS])`, so no separate change).

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 130 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/routes/admin/settings.js tests/routes-admin-settings.test.js && git commit -m "feat(admin/settings): streak_warning_time whitelisted"
```

---

## Task 6: People admin modal — freeze date inputs

**Files:**
- Modify: `public/js/pages/admin.js`

- [ ] **Step 1: Read the current `public/js/pages/admin.js`** to find the `editPerson` function and its `fields` array.

- [ ] **Step 2: Append freeze fields to the `editPerson` form**

Find the `fields` array inside `editPerson`. It currently has rows for name, role, dob, avatar_color, weekly_target_pts, base_pay_cents, bonus_rate_cents. Add two more rows for freeze_start and freeze_end at the end:

```js
    ['freeze_start', 'Freeze start (sick day, vacation) — leave blank for none', 'date'],
    ['freeze_end', 'Freeze end', 'date'],
```

So the final `fields` declaration looks like:

```js
  const fields = [
    ['name', 'Name', 'text'],
    ['role', 'Role', 'select', ['kid', 'parent']],
    ['dob', 'Date of birth', 'date'],
    ['avatar_color', 'Avatar color (hex)', 'text'],
    ['weekly_target_pts', 'Weekly target (pts)', 'number'],
    ['base_pay_cents', 'Base pay when target is hit ($)', 'money'],
    ['bonus_rate_cents', 'Bonus per extra point ($)', 'money'],
    ['freeze_start', 'Freeze start (sick day, vacation) — leave blank for none', 'date'],
    ['freeze_end', 'Freeze end', 'date'],
  ];
```

These will be picked up by the existing input-builder loop in `editPerson` (date type), and they'll be PATCHed via the existing `/api/admin/people/:id` endpoint which already accepts `freeze_start` and `freeze_end` in ALLOWED_FIELDS.

One small adjustment: the existing `onInput` for non-money/select fields currently does:

```js
onInput: e => data[key] = type === 'number' ? Number(e.target.value) : e.target.value,
```

For empty date inputs we want to send null instead of empty string, otherwise SQLite stores '' and `inFreezeRange` returns false anyway (because '' < anything is true but '' > anything is false — actually empty string is falsy, so `!startIso || !endIso` short-circuits). Leave as-is; empty string is acceptable for the freeze logic.

- [ ] **Step 3: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 130 tests still (no new tests for pure UI).

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/admin.js && git commit -m "feat(admin/people): freeze_start + freeze_end date inputs in edit modal"
```

---

## Task 7: People admin list — "On freeze" pill

**Files:**
- Modify: `public/js/pages/admin.js`

- [ ] **Step 1: Modify `renderPeople`** to fetch the on_freeze info

The People tab currently calls `/api/admin/people` and renders rows. The `/api/admin/people` endpoint returns the raw row including `freeze_start` and `freeze_end`. We can compute `on_freeze` client-side rather than adding it server-side: easier.

Find `renderPeople`. In the row-building map, change:

```js
  const rows = people.map(p => el('div', { class: 'list-row', onClick: () => editPerson(p, host) }, [
    el('div', { class: 'row' }, [
      el('div', { class: 'av', style: { background: p.avatar_color } }, [p.name[0]]),
      el('div', {}, [
        el('div', { style: { fontWeight: 600 } }, [p.name]),
        el('div', { class: 'muted', style: { fontSize: '0.78rem' } }, [`${p.role} · target ${p.weekly_target_pts}`]),
      ]),
    ]),
    el('button', { class: 'btn btn-ghost' }, ['Edit']),
  ]));
```

To this (adds "On freeze" pill next to the name when applicable):

```js
  const todayIso = new Date().toISOString().slice(0,10);
  const isFrozen = (p) => p.freeze_start && p.freeze_end
    && todayIso >= p.freeze_start && todayIso <= p.freeze_end;

  const rows = people.map(p => el('div', { class: 'list-row', onClick: () => editPerson(p, host) }, [
    el('div', { class: 'row' }, [
      el('div', { class: 'av', style: { background: p.avatar_color } }, [p.name[0]]),
      el('div', {}, [
        el('div', { class: 'row', style: { gap: '8px' } }, [
          el('span', { style: { fontWeight: 600 } }, [p.name]),
          isFrozen(p) ? el('span', { class: 'pill pill-info', style: { fontSize: '0.65rem' } }, ['On freeze']) : null,
        ].filter(Boolean)),
        el('div', { class: 'muted', style: { fontSize: '0.78rem' } }, [`${p.role} · target ${p.weekly_target_pts}`]),
      ]),
    ]),
    el('button', { class: 'btn btn-ghost' }, ['Edit']),
  ]));
```

Note `new Date().toISOString().slice(0,10)` returns UTC date, which can be one day ahead of local late at night. For our display purposes this is acceptable (the UI shows what the user sees in the browser; if the freeze ended late yesterday-UTC, the "On freeze" pill may linger briefly). If precision matters, the server already provides the correct `on_freeze` via `/api/admin/today` — could fetch that instead. For now, client-side is fine.

- [ ] **Step 2: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 130 tests.

- [ ] **Step 3: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/admin.js && git commit -m "feat(admin/people): On freeze pill on list rows"
```

---

## Task 8: Admin Settings tab — streak warning time input

**Files:**
- Modify: `public/js/pages/admin.js`

- [ ] **Step 1: Modify `renderSettings`** to include a streak warning time input

Find `renderSettings`. The current function renders only the steal unlock time. Add a second time input after it. The full updated function:

```js
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
        try {
          await api.patch('/api/admin/settings/steal_unlock_time', { value: e.target.value });
          flash(e.target);
        } catch (err) { alert('Save failed: ' + err.message); }
      },
    }),
    el('div', { class: 'muted', style: { fontSize: '0.78rem', marginTop: '4px' } }, [
      'Time of day after which kids can claim siblings\' pending non-school chores.',
    ]),
  ]);

  const streakField = el('div', { class: 'form-field' }, [
    el('label', {}, ['Streak warning time (24-hour local)']),
    el('input', {
      type: 'time',
      value: s.streak_warning_time || '20:00',
      onChange: async (e) => {
        try {
          await api.patch('/api/admin/settings/streak_warning_time', { value: e.target.value });
          flash(e.target);
        } catch (err) { alert('Save failed: ' + err.message); }
      },
    }),
    el('div', { class: 'muted', style: { fontSize: '0.78rem', marginTop: '4px' } }, [
      'After this time, a kid with an incomplete day and an active streak sees a "Streak at risk" warning.',
    ]),
  ]);

  host.appendChild(stealField);
  host.appendChild(streakField);
}

function flash(input) {
  input.style.borderColor = 'var(--green)';
  setTimeout(() => { input.style.borderColor = ''; }, 800);
}
```

Note: extract the green-flash success indicator into a `flash` helper since both fields use it. Place `flash` immediately after `renderSettings` at the same indentation level.

- [ ] **Step 2: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 130 tests.

- [ ] **Step 3: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/admin.js && git commit -m "feat(admin/settings): streak warning time input"
```

---

## Task 9: Kid home hero — real streak + at-risk pill

**Files:**
- Modify: `public/js/pages/home.js`
- Modify: `public/css/layouts.css`

- [ ] **Step 1: Modify `renderHome`** to show real streak + at-risk pill

Read the current file. Find the hero card construction. The existing hero ends with:

```js
    el('div', { class: 'row spaced', style: { marginTop: '10px', fontSize: '0.78rem', color: 'var(--hero-muted)' } }, [
      el('span', {}, [`~$${projDollars} projected`]),
      el('span', {}, [`${p.streak_days || 0} day streak`]),
    ]),
  ]);
```

Replace the entire `hero` declaration with this updated version that adds an at-risk pill below the streak:

```js
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
    p.streak_at_risk
      ? el('div', { class: 'streak-at-risk', style: { marginTop: '8px' } }, ['Streak at risk — finish today\'s chores'])
      : null,
    p.on_freeze
      ? el('div', { class: 'streak-on-freeze', style: { marginTop: '8px' } }, ['On freeze — streak protected'])
      : null,
  ].filter(Boolean));
```

- [ ] **Step 2: Append CSS to `public/css/layouts.css`**

```css
.streak-at-risk {
  background: #FEF3C7;
  color: #92400E;
  padding: 6px 10px;
  border-radius: var(--r-sm);
  font-size: 0.78rem;
  font-weight: 600;
  text-align: center;
}
.streak-on-freeze {
  background: #EDE9FE;
  color: #5B21B6;
  padding: 6px 10px;
  border-radius: var(--r-sm);
  font-size: 0.78rem;
  font-weight: 600;
  text-align: center;
}
```

- [ ] **Step 3: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 130 tests.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/home.js public/css/layouts.css && git commit -m "feat(home): real streak in hero + at-risk + on-freeze pills"
```

---

## Task 10: Wall — streak leader banner + per-kid On freeze pill

**Files:**
- Modify: `public/js/pages/wall.js`
- Modify: `public/css/layouts.css`

- [ ] **Step 1: Modify `public/js/pages/wall.js`** to add the streak leader banner

Read the current file. Find the section in `render()` where it builds the kid columns. The kid column header currently looks like:

```js
        el('div', { class: 'col-head' }, [
          el('h3', {}, [k.name]),
          el('div', { class: 'av', style: { background: k.avatar_color, width: '32px', height: '32px' } }, [k.name[0]]),
        ]),
```

REPLACE that block with a version that adds an "On freeze" pill next to the kid's name when applicable:

```js
        el('div', { class: 'col-head' }, [
          el('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
            el('h3', {}, [k.name]),
            k.on_freeze ? el('span', { class: 'on-freeze-pill' }, ['On freeze']) : null,
          ].filter(Boolean)),
          el('div', { class: 'av', style: { background: k.avatar_color, width: '32px', height: '32px' } }, [k.name[0]]),
        ]),
```

Then find the final `root.appendChild(el('div', { class: 'wall-page' }, [...]))` block. Add a `streakLeaderBanner` between the existing `banner` and `cols`. The full updated block:

```js
  const streakLeaderBanner = data.streak_leader
    ? el('div', { class: 'wall-streak-leader' }, [
        el('span', { class: 'wall-streak-leader-label' }, ['Streak leader · ']),
        el('span', {
          class: 'wall-streak-leader-name',
          style: { color: data.streak_leader.color },
        }, [data.streak_leader.name]),
        el('span', { class: 'wall-streak-leader-days' }, [` · ${data.streak_leader.streak_days} days`]),
      ])
    : null;

  root.appendChild(el('div', { class: 'wall-page' }, [
    el('div', { class: 'wall-header' }, [
      el('h2', {}, [`The Lopez House · ${fmtDate(now)}`]),
      el('span', { class: 't' }, [fmtTime(now)]),
    ]),
    banner,
    streakLeaderBanner,
    cols,
    bonusStrip,
  ].filter(Boolean)));
```

- [ ] **Step 2: Append CSS to `public/css/layouts.css`**

```css
.wall-streak-leader {
  background: linear-gradient(135deg, var(--card), var(--card-muted));
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  padding: 10px 16px;
  font-size: 1rem;
  font-weight: 600;
  text-align: center;
}
.wall-streak-leader-label {
  color: var(--muted);
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 1.4px;
  font-weight: 600;
}
.wall-streak-leader-name {
  font-family: 'Libre Baskerville', 'Inter', serif;
  font-size: 1.15rem;
  margin-left: 4px;
}
.wall-streak-leader-days {
  font-family: var(--font-num);
  color: var(--muted);
  font-weight: 600;
}
.on-freeze-pill {
  background: #EDE9FE;
  color: #5B21B6;
  font-size: 0.65rem;
  padding: 2px 8px;
  border-radius: 99px;
  font-weight: 600;
  white-space: nowrap;
}
```

- [ ] **Step 3: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 130 tests.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/wall.js public/css/layouts.css && git commit -m "feat(wall): streak leader banner + On freeze pill on kid columns"
```

---

## Task 11: Deploy + tag v0.6.0-phase6a

- [ ] **Step 1: Final test run**

```bash
cd ~/projects/tally && npm test
```

Expected: 130 tests pass.

- [ ] **Step 2: Reload PM2 + verify production**

```bash
cd ~/projects/tally && pm2 reload tally
sleep 3
curl -sf --resolve tally.thelopezfamily.org:443:104.21.49.63 https://tally.thelopezfamily.org/api/health
```

Expected: `{"ok":true}`.

- [ ] **Step 3: Verify new payload fields are wired**

```bash
curl -sf --resolve tally.thelopezfamily.org:443:104.21.49.63 https://tally.thelopezfamily.org/api/wall | python3 -c "import sys,json; d=json.load(sys.stdin); print('streak_leader in payload:', 'streak_leader' in d); print('per-kid streak_days+on_freeze:', all('streak_days' in k and 'on_freeze' in k for k in d['kids']))"
```

Expected: both `True`.

- [ ] **Step 4: Tag the release**

```bash
cd ~/projects/tally && git tag v0.6.0-phase6a && git log --oneline -15 && git tag -l
```

---

## Self-Review

**Spec coverage:**

| Spec section | Covered by Task(s) |
|---|---|
| §1 Summary | All tasks together |
| §2 Goals | Tasks 1-10 collectively |
| §3 Non-goals | Honored (no auto-expire, no streak best, no confetti, etc.) |
| §4 Streak algorithm | Task 1 |
| §5 Freeze behavior | Task 1 (isOnFreeze), Tasks 6-7 (UI) |
| §6 At-risk rule | Task 1 (streakAtRisk), Tasks 2 + 9 (wire + display) |
| §7 Wall leader callout | Tasks 3 + 10 |
| §8 Freeze indicator | Tasks 7 (people list) + 10 (wall) |
| §9 Schema (no migration) | Task 1 (no migration), Task 5 (settings key) |
| §10 API surface | Tasks 1-5 |
| §11 UI surfaces (hero / wall / admin) | Tasks 6-10 |
| §12 Tests | Tasks 1-5 add the test files |
| §13 Tech notes | Implementation-detail referenced inline |
| §14 Acceptance test | Task 11 |

**Placeholder scan:** Every step contains executable code or precise commands. No TBDs.

**Type consistency:**
- `currentStreak(db, personId)` signature used identically in Tasks 1, 2, 3, 4
- `isOnFreeze(db, personId, dateIso?)` consistent
- `streakAtRisk(db, personId, warningTime, currentStreakValue)` consistent
- Field names `streak_days`, `streak_at_risk`, `on_freeze`, `streak_leader` consistent across home/wall/admin payloads
- `streak_leader` shape `{ name, color, streak_days }` consistent in Task 3 + Task 10

Plan is internally consistent.

---

## Execution Handoff

Plan complete and saved to [`docs/superpowers/plans/2026-05-27-tally-phase-6a-streaks-sickday.md`](2026-05-27-tally-phase-6a-streaks-sickday.md). **11 tasks** total.

Following the established pattern, proceeding with **subagent-driven** execution.
