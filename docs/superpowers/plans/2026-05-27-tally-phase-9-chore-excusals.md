# Tally — Phase 9 Chore Excusals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a parent excuse a single chore for a single day so it drops out of streak math, the points denominator, and the at-risk warning, while the kid still sees it greyed out with the reason.

**Architecture:** Model an excused assignment as `status='excused'` (a new terminal status) with the reason in the existing `note` column. No migration. Additive `AND status != 'excused'` filters in streak/points logic; `'excused'` added to overdue exclusion lists; two new parent endpoints; UI on admin Today, kid home, and wall.

**Tech Stack:** Node 20+, Express 5, better-sqlite3, vanilla JS. No new dependencies, no migration.

**Spec:** [`docs/superpowers/specs/2026-05-27-tally-phase-9-chore-excusals.md`](../specs/2026-05-27-tally-phase-9-chore-excusals.md)

---

## File Structure

```
~/projects/tally/
├── src/
│   ├── lib/
│   │   ├── streak.js                               MODIFY: exclude excused from dayQualifies + streakAtRisk
│   │   └── points.js                               MODIFY: exclude excused from denominator
│   └── routes/
│       ├── home.js                                 MODIFY: overdue filter
│       ├── wall.js                                 MODIFY: overdue filter + count exclusion
│       └── admin/
│           ├── assignments.js                      NEW: excuse + unexcuse endpoints
│           └── today.js                            MODIFY: overdue filter, count exclusion, return id/status/note
├── src/app.js                                      MODIFY: mount assignments routes
├── public/
│   ├── js/pages/
│   │   ├── home.js                                 MODIFY: excused branch in renderTask
│   │   ├── wall.js                                 MODIFY: excused styling + count exclusion
│   │   └── admin.js                                MODIFY: Excuse/Undo links in Today detail
│   └── css/layouts.css                             MODIFY: .txn.excused + .wall task excused styles
└── tests/
    ├── lib-streak.test.js                          MODIFY: excused-day tests
    ├── lib-points.test.js                          MODIFY: excused-denominator test
    └── routes-admin-excuse.test.js                 NEW
```

---

## Task 1: Streak math excludes excused

**Files:**
- Modify: `src/lib/streak.js`
- Modify: `tests/lib-streak.test.js`

- [ ] **Step 1: Add failing tests to `tests/lib-streak.test.js`**

The file already has helpers `seedKid`, `seedChore`, `seedAssignment`, `daysAgo`, `today`. Append:

```js
test('currentStreak: a day with one done and one excused chore qualifies', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c1 = seedChore(db);
  const c2 = seedChore(db);
  seedAssignment(db, c1, kid, today(), 'done');
  seedAssignment(db, c2, kid, today(), 'excused');
  // today fully accounted for (excused drops out) -> counts
  assert.equal(currentStreak(db, kid), 1);
});

test('currentStreak: a day with only an excused chore qualifies vacuously', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, daysAgo(1), 'done');
  const c2 = seedChore(db);
  seedAssignment(db, c2, kid, today(), 'excused');
  // today has only an excused chore -> total 0 -> vacuous qualify -> counts
  assert.equal(currentStreak(db, kid), 2);
});

test('streakAtRisk: false when the only pending chore today is excused', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, today(), 'excused');
  assert.equal(streakAtRisk(db, kid, '00:00', 5), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/projects/tally && node --test tests/lib-streak.test.js
```

Expected: the new tests FAIL (excused still counted in total / still seen as pending).

- [ ] **Step 3: Edit `dayQualifies` in `src/lib/streak.js`**

Change:
```js
    WHERE a.person_id = ? AND a.due_date = ? AND c.kind != 'bonus'
  `).get(personId, dateIso);
```
To:
```js
    WHERE a.person_id = ? AND a.due_date = ? AND c.kind != 'bonus' AND a.status != 'excused'
  `).get(personId, dateIso);
```

- [ ] **Step 4: Edit `streakAtRisk` query in `src/lib/streak.js`**

Change:
```js
      AND a.status != 'done'
      AND c.kind != 'bonus'
    LIMIT 1
```
To:
```js
      AND a.status != 'done'
      AND a.status != 'excused'
      AND c.kind != 'bonus'
    LIMIT 1
```

- [ ] **Step 5: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 156 tests (153 prior + 3 new).

- [ ] **Step 6: Commit**

```bash
cd ~/projects/tally && git add src/lib/streak.js tests/lib-streak.test.js && git commit -m "feat(streak): excused chores drop out of qualification and at-risk check"
```

---

## Task 2: Points denominator excludes excused

**Files:**
- Modify: `src/lib/points.js`
- Modify: `tests/lib-points.test.js`

- [ ] **Step 1: Add a failing test to `tests/lib-points.test.js`**

Append (uses `freshDb`, `calcWeekPoints`, and date helpers already imported in that file; if a helper is missing, add the same inline seeds shown here):

```js
test('calcWeekPoints: excusing a chore removes its weight from the denominator', () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role, weekly_target_pts) VALUES ('K','kid',100) RETURNING id").get().id;
  const c1 = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('A',3,'none','') RETURNING id").get().id;
  const c2 = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('B',3,'none','') RETURNING id").get().id;
  const ws = weekStart(today());
  // Both materialized today; one done, one excused
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, 'done')").run(c1, kid, today());
  const exId = db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, 'pending') RETURNING id").get(c2, kid, today()).id;

  const before = calcWeekPoints(db, kid, ws);
  // With both counted: doneWeight 3 / totalWeight 6 = 50%
  assert.equal(before.totalWeight, 6);
  assert.equal(before.weightedPercent, 0.5);

  db.prepare("UPDATE assignments SET status = 'excused' WHERE id = ?").run(exId);
  const after = calcWeekPoints(db, kid, ws);
  // Excused weight removed: doneWeight 3 / totalWeight 3 = 100%
  assert.equal(after.totalWeight, 3);
  assert.equal(after.weightedPercent, 1);
});
```

Note: this test imports `weekStart` and `today` from `../src/lib/dates.js`. If `tests/lib-points.test.js` does not already import them, add to its imports:
```js
import { today, weekStart } from '../src/lib/dates.js';
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/projects/tally && node --test tests/lib-points.test.js
```

Expected: FAIL — `after.totalWeight` is still 6 (excused weight not removed).

- [ ] **Step 3: Edit the denominator query in `src/lib/points.js`**

The `matRows` query currently reads:
```js
  const matRows = db.prepare(`
    SELECT a.due_date, c.weight
    FROM assignments a
    JOIN chores c ON c.id = a.chore_id
    WHERE a.due_date BETWEEN ? AND date(?, '+6 days')
      AND c.kind != 'bonus'
      AND (
        (a.person_id = ? AND a.stolen_from IS NULL)
        OR a.stolen_from = ?
      )
  `).all(weekStartIso, weekStartIso, personId, personId);
```

Add `AND a.status != 'excused'` after the `c.kind != 'bonus'` line:
```js
  const matRows = db.prepare(`
    SELECT a.due_date, c.weight
    FROM assignments a
    JOIN chores c ON c.id = a.chore_id
    WHERE a.due_date BETWEEN ? AND date(?, '+6 days')
      AND c.kind != 'bonus'
      AND a.status != 'excused'
      AND (
        (a.person_id = ? AND a.stolen_from IS NULL)
        OR a.stolen_from = ?
      )
  `).all(weekStartIso, weekStartIso, personId, personId);
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 157 tests (156 prior + 1 new).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/lib/points.js tests/lib-points.test.js && git commit -m "feat(points): excused chores drop out of the weekly denominator"
```

---

## Task 3: Excuse + unexcuse endpoints

**Files:**
- Create: `src/routes/admin/assignments.js`
- Create: `tests/routes-admin-excuse.test.js`
- Modify: `src/app.js`

- [ ] **Step 1: Write failing tests**

Create `tests/routes-admin-excuse.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';
import { today } from '../src/lib/dates.js';

async function asParent(app, db) {
  const id = db.prepare("INSERT INTO people (name, role) VALUES ('Mom','parent') RETURNING id").get().id;
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id, pin: '1234' });
  return agent;
}
function seedAssignment(db, kind = 'recurring') {
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const c = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees, kind) VALUES ('T',3,'daily','',?) RETURNING id").get(kind).id;
  return db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, 'pending') RETURNING id").get(c, kid, today()).id;
}

test('POST excuse sets status excused and stores note', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const aId = seedAssignment(db);
  const agent = await asParent(app, db);
  const res = await agent.post(`/api/admin/assignments/${aId}/excuse`).send({ note: 'Dog hurt leg' });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT status, note FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'excused');
  assert.equal(row.note, 'Dog hurt leg');
});

test('POST excuse with blank note defaults to Excused by parent', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const aId = seedAssignment(db);
  const agent = await asParent(app, db);
  const res = await agent.post(`/api/admin/assignments/${aId}/excuse`).send({ note: '' });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT note FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.note, 'Excused by parent');
});

test('POST excuse rejects bonus-chore assignments', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const aId = seedAssignment(db, 'bonus');
  const agent = await asParent(app, db);
  const res = await agent.post(`/api/admin/assignments/${aId}/excuse`).send({ note: 'x' });
  assert.equal(res.status, 400);
});

test('POST unexcuse reverts to pending and clears note', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const aId = seedAssignment(db);
  const agent = await asParent(app, db);
  await agent.post(`/api/admin/assignments/${aId}/excuse`).send({ note: 'x' });
  const res = await agent.post(`/api/admin/assignments/${aId}/unexcuse`).send({});
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT status, note FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'pending');
  assert.equal(row.note, null);
});

test('POST unexcuse on a non-excused assignment returns 409', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const aId = seedAssignment(db);
  const agent = await asParent(app, db);
  const res = await agent.post(`/api/admin/assignments/${aId}/unexcuse`).send({});
  assert.equal(res.status, 409);
});

test('excuse endpoints reject non-parent', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const aId = seedAssignment(db);
  const res = await request(app).post(`/api/admin/assignments/${aId}/excuse`).send({ note: 'x' });
  assert.equal(res.status, 401);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL — route doesn't exist (404).

- [ ] **Step 3: Create `src/routes/admin/assignments.js`**

```js
import { Router } from 'express';
import { requireRole } from '../../auth.js';
import { notifyWall } from '../../lib/events.js';

export function adminAssignmentsRoutes() {
  const r = Router();
  r.use(requireRole('parent'));

  r.post('/assignments/:id/excuse', (req, res) => {
    const db = req.app.get('db');
    const id = parseInt(req.params.id, 10);
    const note = (req.body?.note && String(req.body.note).trim()) || 'Excused by parent';
    const a = db.prepare(`
      SELECT a.id FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      WHERE a.id = ? AND c.kind != 'bonus'
    `).get(id);
    if (!a) return res.status(400).json({ error: 'Assignment not found or is a bonus' });
    db.prepare("UPDATE assignments SET status = 'excused', note = ? WHERE id = ?").run(note, id);
    res.json({ ok: true });
    notifyWall();
  });

  r.post('/assignments/:id/unexcuse', (req, res) => {
    const db = req.app.get('db');
    const id = parseInt(req.params.id, 10);
    const a = db.prepare("SELECT status FROM assignments WHERE id = ?").get(id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.status !== 'excused') return res.status(409).json({ error: 'Not excused' });
    db.prepare("UPDATE assignments SET status = 'pending', note = NULL WHERE id = ?").run(id);
    res.json({ ok: true });
    notifyWall();
  });

  return r;
}
```

- [ ] **Step 4: Mount in `src/app.js`**

Add import (after the other admin route imports):
```js
import { adminAssignmentsRoutes } from './routes/admin/assignments.js';
```

Add mount (after `app.use('/api/admin', adminBankRoutes());`):
```js
  app.use('/api/admin', adminAssignmentsRoutes());
```

- [ ] **Step 5: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 163 tests (157 prior + 6 new).

- [ ] **Step 6: Commit**

```bash
cd ~/projects/tally && git add src/routes/admin/assignments.js tests/routes-admin-excuse.test.js src/app.js && git commit -m "feat(admin/assignments): excuse + unexcuse endpoints"
```

---

## Task 4: Overdue filters + count exclusions + today returns id/status/note

**Files:**
- Modify: `src/routes/home.js`
- Modify: `src/routes/wall.js`
- Modify: `src/routes/admin/today.js`

- [ ] **Step 1: Edit `src/routes/home.js` overdue filter**

In the assignments query, change:
```js
        AND (a.due_date = ? OR (a.due_date < ? AND a.status NOT IN ('done','expired','rejected')))
```
To:
```js
        AND (a.due_date = ? OR (a.due_date < ? AND a.status NOT IN ('done','expired','rejected','excused')))
```

- [ ] **Step 2: Edit `src/routes/wall.js` overdue filter + count exclusion**

In the assignment query, change the same `NOT IN ('done','expired','rejected')` to `NOT IN ('done','expired','rejected','excused')`.

Then find the counting loop:
```js
      const bucket = a.due_date === todayIso ? kid.today : kid.overdue;
      bucket.push(a);
      total++;
      if (a.status === 'done') done++;
```
Change to skip excused in the counts (but still push for display):
```js
      const bucket = a.due_date === todayIso ? kid.today : kid.overdue;
      bucket.push(a);
      if (a.status !== 'excused') {
        total++;
        if (a.status === 'done') done++;
      }
```

- [ ] **Step 3: Edit `src/routes/admin/today.js`**

Change the per-kid rows query to include `a.id` and `a.note`, add `'excused'` to the overdue filter, and exclude excused from `today_total`:

```js
      const rows = db.prepare(`
        SELECT a.id, a.status, a.due_date, a.note, c.title
        FROM assignments a
        JOIN chores c ON c.id = a.chore_id
        WHERE a.person_id = ?
          AND (a.due_date = ? OR (a.due_date < ? AND a.status NOT IN ('done','expired','rejected','excused')))
        ORDER BY a.status = 'done', c.title
      `).all(k.id, t, t);
      k.today_total = rows.filter(r => r.due_date === t && r.status !== 'excused').length;
      k.today_done = rows.filter(r => r.due_date === t && r.status === 'done').length;
      k.overdue = rows.filter(r => r.due_date !== t).length;
      k.assignments = rows;
```

(The `total += k.today_total; done += k.today_done;` lines below are unchanged and now naturally exclude excused.)

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 163 tests (existing tests still green; behavior is additive).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/routes/home.js src/routes/wall.js src/routes/admin/today.js && git commit -m "feat(routes): exclude excused from overdue lists and progress counts"
```

---

## Task 5: Kid home UI — excused chore rendering

**Files:**
- Modify: `public/js/pages/home.js`
- Modify: `public/css/layouts.css`

- [ ] **Step 1: Edit `renderTask` in `public/js/pages/home.js`**

Find the class-building lines at the top of `renderTask`:
```js
  const classes = ['txn'];
  if (a.status === 'done') classes.push('done');
  if (a.status === 'submitted') classes.push('submitted');
  if (overdue) classes.push('over');
```
Add an excused class:
```js
  const classes = ['txn'];
  if (a.status === 'done') classes.push('done');
  if (a.status === 'submitted') classes.push('submitted');
  if (a.status === 'excused') classes.push('excused');
  if (overdue) classes.push('over');
```

Find where `action` is assigned (the `if (a.status === 'done')` chain). Add an excused branch FIRST so it short-circuits:
```js
  let action;
  if (a.status === 'excused') {
    action = el('span', { class: 'pill pill-info' }, ['Excused']);
  } else if (a.status === 'done') {
```
(Keep the rest of the chain unchanged; it becomes `else if` naturally since the first `if` now handles excused. Change the existing `if (a.status === 'done')` to `else if (a.status === 'done')`.)

Find the left content block that renders the title + badges:
```js
      el('div', {}, [
        el('span', {}, [a.title]),
        stolenBadge,
        bonusBadge,
      ].filter(Boolean)),
```
Add the excuse reason note when excused:
```js
      el('div', {}, [
        el('span', {}, [a.title]),
        stolenBadge,
        bonusBadge,
        a.status === 'excused' && a.note
          ? el('div', { class: 'muted', style: { fontSize: '0.7rem' } }, [a.note])
          : null,
      ].filter(Boolean)),
```

- [ ] **Step 2: Add CSS to `public/css/layouts.css`**

Append:
```css
.txn.excused { opacity: 0.55; }
.txn.excused .ico { background: #EDE9FE; color: #5B21B6; }
```

- [ ] **Step 3: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 163 tests (client-only change).

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/home.js public/css/layouts.css && git commit -m "feat(home): render excused chores greyed with reason and Excused pill"
```

---

## Task 6: Wall UI — excused styling + count exclusion

**Files:**
- Modify: `public/js/pages/wall.js`
- Modify: `public/css/layouts.css`

- [ ] **Step 1: Edit the wall stats banner count in `public/js/pages/wall.js`**

Find the per-kid stat in the banner:
```js
        el('div', { class: 'st-num' }, [`${k.today.filter(t => t.status === 'done').length}/${k.today.length}`]),
```
Change the denominator to exclude excused:
```js
        el('div', { class: 'st-num' }, [`${k.today.filter(t => t.status === 'done').length}/${k.today.filter(t => t.status !== 'excused').length}`]),
```

- [ ] **Step 2: Edit the task rendering in `public/js/pages/wall.js`**

Find the task class builder in the column:
```js
                  class: 'task' + (t.status === 'done' ? ' done' : '') + (t.over ? ' over' : '') + (t.is_bonus ? ' bonus' : ''),
```
Add an excused class:
```js
                  class: 'task' + (t.status === 'done' ? ' done' : '') + (t.over ? ' over' : '') + (t.is_bonus ? ' bonus' : '') + (t.status === 'excused' ? ' excused' : ''),
```

Then, in the task's inner content, add an "Excused" marker. Find:
```js
                  el('div', {}, [
                    el('span', {}, [t.title]),
                    t.is_bonus ? el('span', { style: { fontSize: '0.62rem', color: '#92400E', marginLeft: '6px' } }, ['★']) : null,
                    t.stolen_from_name ? el('span', { style: { fontSize: '0.62rem', color: 'var(--muted)', marginLeft: '6px' } }, [`(from ${t.stolen_from_name})`]) : null,
                  ].filter(Boolean)),
```
Add an excused tag:
```js
                  el('div', {}, [
                    el('span', {}, [t.title]),
                    t.is_bonus ? el('span', { style: { fontSize: '0.62rem', color: '#92400E', marginLeft: '6px' } }, ['★']) : null,
                    t.stolen_from_name ? el('span', { style: { fontSize: '0.62rem', color: 'var(--muted)', marginLeft: '6px' } }, [`(from ${t.stolen_from_name})`]) : null,
                    t.status === 'excused' ? el('span', { style: { fontSize: '0.62rem', color: '#5B21B6', marginLeft: '6px' } }, ['· Excused']) : null,
                  ].filter(Boolean)),
```

- [ ] **Step 3: Add CSS to `public/css/layouts.css`**

Append:
```css
.wall-col .task.excused { opacity: 0.5; text-decoration: line-through; }
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 163 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/wall.js public/css/layouts.css && git commit -m "feat(wall): excused chores struck-through and excluded from kid stat"
```

---

## Task 7: Admin Today UI — Excuse / Undo links

**Files:**
- Modify: `public/js/pages/admin.js`

- [ ] **Step 1: Rebuild the assignment detail rows in `renderToday`**

The current detail block maps `k.assignments` to simple rows. Replace the `detail` declaration:
```js
      const detail = el('div', { class: 'stack', style: { display: 'none', marginTop: '8px', gap: '4px' } },
        (k.assignments || []).map(a => el('div', {
          style: {
            fontSize: '0.82rem',
            padding: '4px 8px',
            borderRadius: 'var(--r-sm)',
            background: a.status === 'done' ? 'var(--card-muted)' : 'transparent',
            color: a.status === 'done' ? 'var(--muted)' : 'var(--ink)',
            textDecoration: a.status === 'done' ? 'line-through' : 'none',
            display: 'flex', justifyContent: 'space-between',
          },
        }, [
          el('span', {}, [a.title]),
          el('span', { style: { fontSize: '0.72rem', color: 'var(--muted)' } }, [
            a.due_date !== d.today ? 'overdue' : a.status,
          ]),
        ]))
      );
```

With a version that adds Excuse/Undo actions (note `e.stopPropagation()` so the action does not toggle the panel collapse):
```js
      const detail = el('div', { class: 'stack', style: { display: 'none', marginTop: '8px', gap: '4px' } },
        (k.assignments || []).map(a => {
          const right = a.status === 'excused'
            ? el('span', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
                el('span', { style: { fontSize: '0.72rem', color: '#5B21B6' } }, [`Excused: ${a.note || ''}`]),
                el('button', { class: 'btn btn-ghost btn-sm', onClick: async (e) => {
                  e.stopPropagation();
                  try { await api.post(`/api/admin/assignments/${a.id}/unexcuse`, {}); renderToday(host); }
                  catch (err) { alert(err.message); }
                }}, ['Undo']),
              ])
            : el('span', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
                el('span', { style: { fontSize: '0.72rem', color: 'var(--muted)' } }, [
                  a.due_date !== d.today ? 'overdue' : a.status,
                ]),
                a.status !== 'done'
                  ? el('button', { class: 'btn btn-ghost btn-sm', onClick: async (e) => {
                      e.stopPropagation();
                      const reason = prompt(`Why is "${a.title}" excused?`, '');
                      if (reason === null) return;
                      try { await api.post(`/api/admin/assignments/${a.id}/excuse`, { note: reason }); renderToday(host); }
                      catch (err) { alert(err.message); }
                    }}, ['Excuse'])
                  : null,
              ].filter(Boolean));
          return el('div', {
            style: {
              fontSize: '0.82rem',
              padding: '4px 8px',
              borderRadius: 'var(--r-sm)',
              background: a.status === 'done' ? 'var(--card-muted)' : 'transparent',
              color: a.status === 'done' ? 'var(--muted)' : 'var(--ink)',
              textDecoration: a.status === 'done' ? 'line-through' : 'none',
              opacity: a.status === 'excused' ? 0.7 : 1,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            },
          }, [
            el('span', {}, [a.title]),
            right,
          ]);
        })
      );
```

- [ ] **Step 2: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 163 tests.

- [ ] **Step 3: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/admin.js && git commit -m "feat(admin/today): Excuse + Undo actions on each assignment row"
```

---

## Task 8: Deploy + tag v0.9.0-phase9

- [ ] **Step 1: Final test run**

```bash
cd ~/projects/tally && npm test
```

Expected: 163 tests pass.

- [ ] **Step 2: Reload PM2 + verify**

```bash
cd ~/projects/tally && pm2 reload tally
sleep 3
curl -sf http://localhost:3012/api/health
```

Expected: `{"ok":true}`.

- [ ] **Step 3: Smoke-test the excuse flow end to end**

```bash
cd ~/projects/tally && node -e "
import('./src/db.js').then(async m => {
  const db = m.openDb(':memory:');
  const kid = db.prepare(\"INSERT INTO people (name, role, weekly_target_pts) VALUES ('K','kid',100) RETURNING id\").get().id;
  const c = db.prepare(\"INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('Walk dogs',3,'daily','') RETURNING id\").get().id;
  const a = db.prepare(\"INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now','localtime'), 'pending') RETURNING id\").get(c, kid).id;
  const { streakAtRisk } = await import('./src/lib/streak.js');
  db.prepare(\"UPDATE assignments SET status='excused', note='Dog hurt leg' WHERE id=?\").run(a);
  console.log('at risk after excuse (expect false):', streakAtRisk(db, kid, '00:00', 5));
});
"
```

Expected: `at risk after excuse (expect false): false`.

- [ ] **Step 4: Tag the release**

```bash
cd ~/projects/tally && git tag v0.9.0-phase9 && git log --oneline -12 && git tag -l 'v*'
```

---

## Self-Review

**Spec coverage:**

| Spec section | Covered by Task(s) |
|---|---|
| §1 Summary | All tasks |
| §2 Goals (per-day excusal, zero streak/pay impact, no false warning, transparent, reversible) | Tasks 1-7 |
| §3 Non-goals | Honored (one-day only, parent-only, no bonus excuse, no audit) |
| §4 Mechanism (status='excused' + note, no migration) | Tasks 1-3 |
| §5 Endpoints | Task 3 |
| §6 Streak math | Task 1 |
| §7 Points math | Task 2 |
| §8 Overdue filters | Task 4 |
| §9 Count exclusions (wall, admin today) | Tasks 4 (server), 6 (wall UI) |
| §10 UI (admin today, kid home, wall) | Tasks 5, 6, 7 |
| §11 Tests | Tasks 1, 2, 3 |
| §12 Tech notes | Implementation in Tasks 1-4 |
| §13 Acceptance test | Task 8 |

**Placeholder scan:** Every step has exact code or commands. No TBDs.

**Type consistency:**
- `status === 'excused'` used consistently across streak (Task 1), points (Task 2), routes (Task 4), and all UI (Tasks 5-7)
- excuse/unexcuse endpoint paths `/api/admin/assignments/:id/excuse` and `/unexcuse` consistent between Task 3 (definition) and Task 7 (UI callers)
- `k.assignments` rows carry `id`, `status`, `due_date`, `note`, `title` — produced in Task 4 (today route), consumed in Task 7 (admin UI)
- `note` holds the reason consistently (Task 3 writes it, Tasks 5 + 7 display it)
- `notifyWall()` called from both endpoints (Task 3), matching the Phase 5 pattern

Plan is internally consistent.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-27-tally-phase-9-chore-excusals.md`. 8 tasks. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks

**2. Inline Execution** — I execute directly in this session (has worked well for recent phases)

Which approach?
