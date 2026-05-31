# Tally — Freeze Suspends the Day Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a kid's freeze window actually suspend their day — pending chores get excused (reusing the Phase 9 excused machinery) and the generator stops creating new chores for them — instead of just protecting their streak.

**Architecture:** New `src/lib/freeze.js` exports `applyFreezeSweep(db, personId)`, a one-shot side effect that flips pending non-bonus chores in the active window `[max(freeze_start, today()), freeze_end]` to `status='excused'` with note `'On freeze'`. The People PATCH route calls it after any update that touched freeze fields. The chore generator gains a per-kid `isOnFreeze` skip so future days in the window never get rows.

**Tech Stack:** Same as project — Node 20 ESM, Express 5, better-sqlite3. No schema change, no migration, no new dependencies.

**Spec:** [`docs/superpowers/specs/2026-05-29-tally-freeze-suspends-day-design.md`](../specs/2026-05-29-tally-freeze-suspends-day-design.md)

---

## File Structure

```
~/projects/tally/
├── src/
│   ├── lib/
│   │   ├── freeze.js                       NEW: applyFreezeSweep
│   │   └── assignments.js                  MODIFY: skip frozen kids in generator
│   └── routes/admin/
│       └── people.js                       MODIFY: call applyFreezeSweep after PATCH
└── tests/
    ├── lib-freeze.test.js                  NEW
    ├── assignments-generator.test.js       MODIFY: add frozen-kid skip tests
    └── routes-admin-people.test.js         MODIFY: add PATCH-triggers-sweep tests
```

---

## Task 1: `src/lib/freeze.js` — applyFreezeSweep + tests

**Files:**
- Create: `src/lib/freeze.js`
- Create: `tests/lib-freeze.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/lib-freeze.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { applyFreezeSweep } from '../src/lib/freeze.js';
import { today, toIso } from '../src/lib/dates.js';

function seedKid(db, name = 'K') {
  return db.prepare("INSERT INTO people (name, role) VALUES (?, 'kid') RETURNING id").get(name).id;
}
function seedChore(db, kind = 'recurring') {
  return db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees, kind) VALUES ('T',3,'daily','',?) RETURNING id").get(kind).id;
}
function seedAssignment(db, choreId, kidId, dueDate, status = 'pending') {
  return db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, ?) RETURNING id").get(choreId, kidId, dueDate, status).id;
}
function setFreeze(db, kidId, startIso, endIso) {
  db.prepare("UPDATE people SET freeze_start = ?, freeze_end = ? WHERE id = ?").run(startIso, endIso, kidId);
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toIso(d);
}
function daysFromNow(n) {
  return daysAgo(-n);
}

test('applyFreezeSweep excuses a pending chore on today when freeze covers today', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  const aId = seedAssignment(db, c, kid, today(), 'pending');
  setFreeze(db, kid, today(), today());
  applyFreezeSweep(db, kid);
  const row = db.prepare('SELECT status, note FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'excused');
  assert.equal(row.note, 'On freeze');
});

test('applyFreezeSweep leaves a done chore alone (today still in window)', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  const aId = seedAssignment(db, c, kid, today(), 'done');
  setFreeze(db, kid, today(), today());
  applyFreezeSweep(db, kid);
  const row = db.prepare('SELECT status FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'done');
});

test('applyFreezeSweep leaves a chore on a past day alone, even if inside freeze range', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  // pending chore from 2 days ago; freeze covers a range that includes it
  const aId = seedAssignment(db, c, kid, daysAgo(2), 'pending');
  setFreeze(db, kid, daysAgo(3), today());
  applyFreezeSweep(db, kid);
  const row = db.prepare('SELECT status FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'pending'); // past day stays untouched
});

test('applyFreezeSweep excuses a pending chore on a FUTURE day inside the freeze window', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  const aId = seedAssignment(db, c, kid, daysFromNow(2), 'pending');
  setFreeze(db, kid, today(), daysFromNow(3));
  applyFreezeSweep(db, kid);
  const row = db.prepare('SELECT status FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'excused');
});

test('applyFreezeSweep does NOT touch bonus-chore assignments', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db, 'bonus');
  const aId = seedAssignment(db, c, kid, today(), 'pending');
  setFreeze(db, kid, today(), today());
  applyFreezeSweep(db, kid);
  const row = db.prepare('SELECT status FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'pending'); // bonus claim untouched
});

test('applyFreezeSweep is a no-op when the kid has no freeze set', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  const aId = seedAssignment(db, c, kid, today(), 'pending');
  // no setFreeze call
  applyFreezeSweep(db, kid);
  const row = db.prepare('SELECT status FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'pending');
});

test('applyFreezeSweep is a no-op when freeze_end is already in the past', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  const aId = seedAssignment(db, c, kid, today(), 'pending');
  setFreeze(db, kid, daysAgo(5), daysAgo(2)); // already-ended freeze
  applyFreezeSweep(db, kid);
  const row = db.prepare('SELECT status FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'pending');
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd ~/projects/tally && node --test tests/lib-freeze.test.js
```

Expected: FAIL — `src/lib/freeze.js` doesn't exist.

- [ ] **Step 3: Create `src/lib/freeze.js`**

```js
import { today } from './dates.js';

/**
 * One-shot side effect: when a parent saves a freeze on a kid, excuse any
 * pending non-bonus chores in the active window so they stop appearing as
 * required work. Done / submitted / rejected / expired / already-excused
 * rows are left alone. Past days outside the active window (which starts at
 * today) are untouched.
 *
 * Idempotent: re-running on the same window does nothing because the rows
 * are no longer pending.
 */
export function applyFreezeSweep(db, personId) {
  const person = db.prepare(
    'SELECT freeze_start, freeze_end FROM people WHERE id = ?'
  ).get(personId);
  if (!person || !person.freeze_start || !person.freeze_end) return;

  const t = today();
  const windowStart = person.freeze_start > t ? person.freeze_start : t;
  const windowEnd = person.freeze_end;
  if (windowEnd < windowStart) return; // freeze already over (or invalid)

  db.prepare(`
    UPDATE assignments
    SET status = 'excused',
        note = 'On freeze',
        updated_at = datetime('now')
    WHERE person_id = ?
      AND status = 'pending'
      AND due_date BETWEEN ? AND ?
      AND chore_id IN (SELECT id FROM chores WHERE kind != 'bonus')
  `).run(personId, windowStart, windowEnd);
}
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && node --test tests/lib-freeze.test.js && npm test 2>&1 | tail -6
```

Expected: lib-freeze passes (7 tests); full suite 189 pass (182 prior + 7 new), 0 fail.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/lib/freeze.js tests/lib-freeze.test.js && git commit -m "feat(freeze): applyFreezeSweep excuses pending chores in active window"
```

---

## Task 2: Generator skips frozen kids

**Files:**
- Modify: `src/lib/assignments.js`
- Modify: `tests/assignments-generator.test.js`

- [ ] **Step 1: Add the failing test**

Append to `tests/assignments-generator.test.js`. The file already imports `freshDb`, `generateForToday`, `today`, and has helpers `seedKid` and `seedChore`. Add at the bottom:

```js
import { toIso } from '../src/lib/dates.js';

test('generateForToday skips kids who are on freeze today', () => {
  const db = freshDb();
  const frozen = seedKid(db, 'Frozen');
  const active = seedKid(db, 'Active');
  // both kids share the same daily chore
  const chore = seedChore(db, {
    title: 'Make bed', recurs: 'daily', kind: 'recurring',
    default_assignees: `${frozen},${active}`,
  });
  // freeze covers today for the frozen kid
  db.prepare("UPDATE people SET freeze_start = ?, freeze_end = ? WHERE id = ?")
    .run(today(), today(), frozen);

  generateForToday(db);

  const frozenRows = db.prepare('SELECT * FROM assignments WHERE person_id = ?').all(frozen);
  const activeRows = db.prepare('SELECT * FROM assignments WHERE person_id = ?').all(active);
  assert.equal(frozenRows.length, 0, 'no row generated for frozen kid');
  assert.equal(activeRows.length, 1, 'active kid still gets the chore');
});
```

If `toIso` is already imported at the top, do not add the import again — adjust as needed.

- [ ] **Step 2: Run to verify failure**

```bash
cd ~/projects/tally && node --test tests/assignments-generator.test.js
```

Expected: FAIL — the new test sees a row for the frozen kid.

- [ ] **Step 3: Modify `src/lib/assignments.js`**

Add the import next to the existing `dates.js` import at the top:

```js
import { isOnFreeze } from './streak.js';
```

Find the per-chore insertion loop:

```js
      const assignees = c.default_assignees.split(',').map(s => parseInt(s, 10)).filter(Boolean);
      for (const personId of assignees) {
        insert.run(c.id, personId, date);
      }
```

Change to skip frozen kids:

```js
      const assignees = c.default_assignees.split(',').map(s => parseInt(s, 10)).filter(Boolean);
      for (const personId of assignees) {
        if (isOnFreeze(db, personId, date)) continue;
        insert.run(c.id, personId, date);
      }
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && node --test tests/assignments-generator.test.js && npm test 2>&1 | tail -6
```

Expected: generator tests pass; full suite 190 (189 + 1 new), 0 fail.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/lib/assignments.js tests/assignments-generator.test.js && git commit -m "feat(generator): skip frozen kids when creating daily assignments"
```

---

## Task 3: People PATCH triggers applyFreezeSweep

**Files:**
- Modify: `src/routes/admin/people.js`
- Modify: `tests/routes-admin-people.test.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/routes-admin-people.test.js`. The file already defines an `asParent(app, db)` helper. Add at the bottom:

```js
import { today } from '../src/lib/dates.js';

test('PATCH /api/admin/people/:id with freeze covering today excuses kid pending chores', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const c = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('T',3,'daily','') RETURNING id").get().id;
  const aId = db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, 'pending') RETURNING id").get(c, kid, today()).id;
  const app = freshApp(db);
  const agent = await asParent(app, db);

  const res = await agent.patch(`/api/admin/people/${kid}`).send({ freeze_start: today(), freeze_end: today() });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT status, note FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'excused');
  assert.equal(row.note, 'On freeze');
});

test('PATCH that does NOT touch freeze fields does NOT excuse any chores', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const c = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('T',3,'daily','') RETURNING id").get().id;
  const aId = db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, 'pending') RETURNING id").get(c, kid, today()).id;
  // seed a freeze that COULD apply, but the PATCH below shouldn't trigger a sweep
  db.prepare("UPDATE people SET freeze_start = ?, freeze_end = ? WHERE id = ?").run(today(), today(), kid);
  const app = freshApp(db);
  const agent = await asParent(app, db);

  const res = await agent.patch(`/api/admin/people/${kid}`).send({ weekly_target_pts: 75 });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT status FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'pending');
});
```

Confirm `freshApp` is already imported at the top of the file; if not, add it. Same for `today` if not present.

- [ ] **Step 2: Run to verify failure**

```bash
cd ~/projects/tally && node --test tests/routes-admin-people.test.js
```

Expected: FAIL — the first new test sees status still `pending` (PATCH isn't triggering the sweep yet).

- [ ] **Step 3: Modify `src/routes/admin/people.js`**

Add the import at the top:

```js
import { applyFreezeSweep } from '../../lib/freeze.js';
```

In the `PATCH` handler, after `if (!person)` and BEFORE `res.json(...)`, add the conditional sweep:

```js
  r.patch('/people/:id', (req, res) => {
    const db = req.app.get('db');
    const data = pickFields(req.body || {});
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'nothing to update' });
    const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
    const person = db.prepare(`
      UPDATE people SET ${sets} WHERE id = ? RETURNING *
    `).get(...Object.values(data), req.params.id);
    if (!person) return res.status(404).json({ error: 'Not found' });
    if (data.freeze_start !== undefined || data.freeze_end !== undefined) {
      applyFreezeSweep(db, person.id);
    }
    res.json({ person });
  });
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && node --test tests/routes-admin-people.test.js && npm test 2>&1 | tail -6
```

Expected: people tests pass; full suite 192 (190 + 2 new), 0 fail.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/routes/admin/people.js tests/routes-admin-people.test.js && git commit -m "feat(admin/people): PATCH triggers freeze sweep when freeze dates change"
```

---

## Task 4: Deploy + tag v0.10.1

- [ ] **Step 1: Final test run**

```bash
cd ~/projects/tally && npm test 2>&1 | grep -E "# (tests|pass|fail)"
```

Expected: 192 pass, 0 fail.

- [ ] **Step 2: Reload PM2 + verify health**

```bash
cd ~/projects/tally && pm2 reload tally 2>&1 | tail -1 && sleep 2 && curl -sf http://localhost:3012/api/health && echo " <- health"
```

Expected: `{"ok":true}`.

- [ ] **Step 3: Tag and push**

```bash
cd ~/projects/tally && git tag v0.10.1-freeze-suspends-day && git push origin master && git push origin --tags 2>&1 | tail -3
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task(s) |
|---|---|
| §4 Mechanism (reuse excused) | Tasks 1, 2 |
| §5 Sweep `applyFreezeSweep` | Task 1 |
| §6 Generator skip | Task 2 |
| §7 PATCH integration | Task 3 |
| §8 Tests (lib-freeze, generator, PATCH) | Tasks 1, 2, 3 |
| §9 Tech notes (idempotency, reuse, one-way) | Inherent in the sweep's `WHERE status = 'pending'` and PATCH conditional |
| §10 Acceptance | Task 4 + manual |

**Placeholder scan:** Every step has concrete code or commands. No TBDs.

**Type consistency:**
- `applyFreezeSweep(db, personId)` signature consistent across `src/lib/freeze.js` (Task 1) and `src/routes/admin/people.js` (Task 3).
- `isOnFreeze` imported from `./streak.js` in `assignments.js` (Task 2) — that's where it already lives.
- The sweep's `status = 'excused'` + `note = 'On freeze'` matches what every Phase 9 consumer already expects.
- Window math uses `freeze_start` / `freeze_end` (TEXT ISO date strings on `people`), compared lexicographically — works for ISO dates.

Plan is internally consistent.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-29-tally-freeze-suspends-day.md`. 4 tasks. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, I verify each diff and run the suite between tasks
**2. Inline** — I do it directly in this session

Which approach?
