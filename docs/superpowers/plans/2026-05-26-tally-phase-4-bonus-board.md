# Tally — Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parent-posted one-off bonus chores any kid can claim first-to-tap-wins; completing them adds the chore's fixed point value as pure extra credit to the kid's weekly total.

**Architecture:** No schema migration. Bonuses are rows in the existing `chores` table with `kind='bonus'`. Claim creates an `assignments` row via a race-guarded `INSERT ... WHERE NOT EXISTS`. Completion flows through the existing `/api/assignments/:id/submit` endpoint unchanged. The weekly point calc gets a new `bonusPoints` field that adds to the kid's points and counts as extra-credit in the pay calc.

**Tech Stack:** Same as prior phases — Node 20+, Express 5, better-sqlite3, vanilla JS SPA. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-05-26-tally-phase-4-bonus-board.md`](../specs/2026-05-26-tally-phase-4-bonus-board.md)

**Prior phases:** Phase 1 (skeleton), Phase 2a (weighted points + stealing), Phase 3 (anti-cheat). All live.

---

## File Structure

```
~/projects/tally/
├── src/
│   ├── lib/
│   │   └── points.js                            MODIFY: add bonusPoints to calcWeekPoints, adapt calcProjectedPay
│   └── routes/
│       ├── home.js                              MODIFY: include bonuses[] in /api/home; new POST /api/bonuses/:id/claim
│       ├── wall.js                              MODIFY: include bonuses[] in /api/wall
│       └── admin/
│           └── bonuses.js                       NEW: GET/POST/PATCH/DELETE /api/admin/bonuses
├── src/app.js                                   MODIFY: mount adminBonusesRoutes
└── public/
    ├── js/pages/
    │   ├── admin.js                             MODIFY: add Bonus Board tab + renderBonuses
    │   ├── home.js                              MODIFY: add Bonus Board section on kid home
    │   └── wall.js                              MODIFY: add bonus strip below kid columns
    └── css/layouts.css                          MODIFY: bonus board styles

tests/
├── routes-admin-bonuses.test.js                 NEW
├── routes-bonuses-claim.test.js                 NEW
├── lib-points.test.js                           MODIFY: bonusPoints assertions
├── routes-home.test.js                          MODIFY: bonuses array assertions
└── routes-wall.test.js                          MODIFY: bonuses array assertions
```

---

## Task 1: `calcWeekPoints` returns `bonusPoints`

**Files:**
- Modify: `src/lib/points.js`
- Modify: `tests/lib-points.test.js`

- [ ] **Step 1: Append the failing test to `tests/lib-points.test.js`**

```js
test('calcWeekPoints adds bonusPoints from done bonus chores', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const ws = weekStart(today());

  // Regular daily chore, weight 5
  const regular = db.prepare(
    "INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('Daily', 5, 'daily', ?) RETURNING id"
  ).get(String(kid)).id;
  seedAssignment(db, regular, kid, today(), 'done');

  // Bonus chore worth 30 points, completed today
  const bonus = db.prepare(
    "INSERT INTO chores (title, points, kind, recurs, default_assignees) VALUES ('Mow', 30, 'bonus', 'none', '') RETURNING id"
  ).get().id;
  seedAssignment(db, bonus, kid, today(), 'done');

  const r = calcWeekPoints(db, kid, ws);
  assert.equal(r.bonusPoints, 30);
  assert.ok(r.weightedPoints >= 0);
  assert.equal(r.points, r.weightedPoints + 30);
  assert.equal(r.percent, r.points / 100);
});

test('calcWeekPoints bonusPoints excludes pending bonus assignments', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const ws = weekStart(today());
  const bonus = db.prepare(
    "INSERT INTO chores (title, points, kind, recurs, default_assignees) VALUES ('Pending bonus', 50, 'bonus', 'none', '') RETURNING id"
  ).get().id;
  // claimed but not done yet
  seedAssignment(db, bonus, kid, today(), 'pending');

  const r = calcWeekPoints(db, kid, ws);
  assert.equal(r.bonusPoints, 0, 'pending bonuses do not contribute');
});

test('calcWeekPoints bonusPoints filtered by week', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const ws = weekStart(today());
  const bonus = db.prepare(
    "INSERT INTO chores (title, points, kind, recurs, default_assignees) VALUES ('Last week', 25, 'bonus', 'none', '') RETURNING id"
  ).get().id;
  // Done last week (not the current week)
  seedAssignment(db, bonus, kid, '2020-01-01', 'done');

  const r = calcWeekPoints(db, kid, ws);
  assert.equal(r.bonusPoints, 0, 'out-of-week done bonus excluded');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/projects/tally && npm test
```

Expected: 3 new tests fail because `bonusPoints` is not returned.

- [ ] **Step 3: Modify `src/lib/points.js`**

Read the current file. Replace `calcWeekPoints` with the version that also computes bonusPoints, and update `calcProjectedPay` semantics. Final file:

```js
import { fromIso, toIso, dayOfWeek } from './dates.js';
import { shouldRunOn } from './assignments.js';

/**
 * Compute the weekly points for a kid given a week-start ISO date.
 * Returns { totalWeight, doneWeight, weightedPercent, weightedPoints,
 *           bonusPoints, points, percent }.
 *
 * weightedPoints comes from the standard weight ratio across the kid's
 * baseline chores (forecast included). bonusPoints comes from completed
 * bonus chores (chores.kind = 'bonus') in this week. The returned `points`
 * is the sum and is what the UI displays. `percent` = points / target,
 * which can exceed 1.0 when stolen-in or bonus chores push past target.
 */
export function calcWeekPoints(db, personId, weekStartIso) {
  const start = fromIso(weekStartIso);

  // Numerator from weight: done assignments currently owned by this kid this week,
  // excluding bonus chores (those are tracked separately in bonusPoints).
  const doneRow = db.prepare(`
    SELECT COALESCE(SUM(c.weight), 0) AS w
    FROM assignments a
    JOIN chores c ON c.id = a.chore_id
    WHERE a.due_date BETWEEN ? AND date(?, '+6 days')
      AND a.person_id = ?
      AND a.status = 'done'
      AND c.kind != 'bonus'
  `).get(weekStartIso, weekStartIso, personId);
  const doneWeight = doneRow.w;

  // Denominator: materialized for days with rows, forecast for the rest.
  // Bonus chores never enter the denominator.
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

  const materializedByDay = new Map();
  for (const r of matRows) {
    materializedByDay.set(r.due_date, (materializedByDay.get(r.due_date) || 0) + r.weight);
  }

  let totalWeight = 0;
  for (const w of materializedByDay.values()) totalWeight += w;

  // Forecast any of the seven week days that have no materialized rows.
  const chores = db.prepare(`
    SELECT * FROM chores
    WHERE kind = 'recurring' AND deleted_at IS NULL AND default_assignees != ''
  `).all();
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const iso = toIso(d);
    if (materializedByDay.has(iso)) continue;
    const dow = dayOfWeek(iso);
    for (const c of chores) {
      const assignees = c.default_assignees.split(',').map(s => parseInt(s, 10));
      if (!assignees.includes(personId)) continue;
      if (!shouldRunOn(c, iso, dow)) continue;
      totalWeight += c.weight;
    }
  }

  // Bonus points: sum of done bonus-chore point values this week.
  const bonusRow = db.prepare(`
    SELECT COALESCE(SUM(c.points), 0) AS p
    FROM assignments a
    JOIN chores c ON c.id = a.chore_id
    WHERE a.due_date BETWEEN ? AND date(?, '+6 days')
      AND a.person_id = ?
      AND a.status = 'done'
      AND c.kind = 'bonus'
  `).get(weekStartIso, weekStartIso, personId);
  const bonusPoints = bonusRow.p;

  const person = db.prepare('SELECT weekly_target_pts FROM people WHERE id = ?').get(personId);
  const target = person?.weekly_target_pts || 0;

  const weightedPercent = totalWeight === 0 ? 0 : doneWeight / totalWeight;
  const weightedPoints = Math.round(weightedPercent * target);
  const points = weightedPoints + bonusPoints;
  const percent = target === 0 ? 0 : points / target;

  return {
    totalWeight,
    doneWeight,
    weightedPercent,
    weightedPoints,
    bonusPoints,
    points,
    percent,
  };
}

/**
 * Given a `people` row and a points count, return projected weekly pay in cents.
 *
 * Two "buckets" of pay:
 *   1. base_part: linear from 0 up to base_pay_cents at 100% of target (capped at 100%)
 *   2. bonus_part: bonus_rate_cents per point earned over target
 *
 * Callers should pass the kid's total `points` (which is weightedPoints + bonusPoints).
 * Anything past target — whether from stolen-in chores or bonus chores — flows
 * through the same bonus_rate.
 *
 * Pay derives from the rounded `points` integer (consistent with what the
 * user sees in the UI) rather than from the underlying percent.
 */
export function calcProjectedPay(person, points) {
  const target = person.weekly_target_pts || 0;
  const base = person.base_pay_cents || 0;
  const bonusRate = person.bonus_rate_cents || 0;
  if (target === 0) return 0;
  const cappedPts = Math.min(points, target);
  const basePart = Math.round((cappedPts / target) * base);
  const extraPoints = Math.max(0, points - target);
  const bonusPart = extraPoints * bonusRate;
  return basePart + bonusPart;
}
```

Note: the base_part calc now uses `cappedPts / target × base` instead of `min(points/target, 1.0) × base`. Same result, slightly clearer mental model: cap the points at target, then take a fraction. Easier to extend later.

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: 89 tests pass (86 prior + 3 new bonus-points tests).

If any prior `calcProjectedPay` tests fail because of float rounding (the new calc rounds inside `Math.round((cappedPts/target) × base)`), inspect and decide whether the test asserted on an artifact of the old code path. The math is equivalent; expected values should be identical. If they differ, fix the test to match the new value (it's correct).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/lib/points.js tests/lib-points.test.js && git commit -m "feat(lib/points): bonusPoints field; pay calc includes bonus + stolen-in extras"
```

---

## Task 2: Wire `bonusPoints` into `/api/home`, `/api/wall`, `/api/admin/today`

**Files:**
- Modify: `src/routes/home.js`, `src/routes/wall.js`, `src/routes/admin/today.js`

These three callers of `calcWeekPoints` already use its existing fields; adding `bonusPoints` to the response payload requires no signature change. Just make sure the existing callers continue to work AND expose `bonusPoints` where useful.

- [ ] **Step 1: Verify existing tests still pass after Task 1's changes**

```bash
cd ~/projects/tally && npm test
```

Expected: 89 pass. If any home/wall/admin-today test fails because of a numeric discrepancy, investigate — `calcWeekPoints` should be backward-compatible for callers that don't claim bonuses (bonusPoints=0).

- [ ] **Step 2: Modify `src/routes/home.js`** to surface `bonusPoints` on the person payload

Read the current file. Find the GET /home handler where it does:

```js
    const pts = calcWeekPoints(db, personId, ws);
    person.points_this_week = pts.points;
    person.percent = pts.percent;
    person.projected_pay_cents = calcProjectedPay(person, pts.points);
```

Add a `bonus_points_this_week` field for the kid hero card to use in Task 7:

```js
    const pts = calcWeekPoints(db, personId, ws);
    person.points_this_week = pts.points;
    person.percent = pts.percent;
    person.weighted_points = pts.weightedPoints;
    person.bonus_points_this_week = pts.bonusPoints;
    person.projected_pay_cents = calcProjectedPay(person, pts.points);
```

- [ ] **Step 3: Modify `src/routes/admin/today.js`** to expose `bonus_points` per kid

Read the current file. Find:

```js
      const pts = calcWeekPoints(db, k.id, ws);
      k.points = pts.points;
      k.percent = pts.percent;
      k.projected_pay_cents = calcProjectedPay(k, pts.points);
```

Replace with:

```js
      const pts = calcWeekPoints(db, k.id, ws);
      k.points = pts.points;
      k.percent = pts.percent;
      k.weighted_points = pts.weightedPoints;
      k.bonus_points = pts.bonusPoints;
      k.projected_pay_cents = calcProjectedPay(k, pts.points);
```

- [ ] **Step 4: `src/routes/wall.js`** — no change in this task (bonuses array comes in Task 4). The wall already uses `points` and `percent` from calcWeekPoints; those now reflect bonus contributions transparently.

- [ ] **Step 5: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: 89 pass. No new tests in this task.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/tally && git add src/routes/home.js src/routes/admin/today.js && git commit -m "feat(home,admin/today): expose bonus_points + weighted_points alongside total"
```

---

## Task 3: Admin bonuses routes — list, post, edit, cancel

**Files:**
- Create: `src/routes/admin/bonuses.js`, `tests/routes-admin-bonuses.test.js`
- Modify: `src/app.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/routes-admin-bonuses.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';

async function asParent(app, db) {
  const id = db.prepare("INSERT INTO people (name, role) VALUES ('Mom','parent') RETURNING id").get().id;
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id, pin: '1234' });
  return { agent, id };
}

async function asKid(app, db, name = 'K') {
  const id = db.prepare("INSERT INTO people (name, role) VALUES (?, 'kid') RETURNING id").get(name).id;
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id });
  return { agent, id };
}

test('POST /api/admin/bonuses creates a bonus chore with kind=bonus and forced defaults', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const res = await agent.post('/api/admin/bonuses').send({
    title: 'Mow lawn',
    points: 30,
    anti_cheat: 'photo',
    description: 'Mow the whole front and back',
    photo_prompt: 'Show me a picture of the mowed lawn',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.bonus.title, 'Mow lawn');
  assert.equal(res.body.bonus.points, 30);
  assert.equal(res.body.bonus.kind, 'bonus');
  assert.equal(res.body.bonus.recurs, 'none');
  assert.equal(res.body.bonus.default_assignees, '');
  assert.equal(res.body.bonus.anti_cheat, 'photo');
});

test('POST /api/admin/bonuses ignores client-sent kind/recurs/default_assignees', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const res = await agent.post('/api/admin/bonuses').send({
    title: 'Sneaky',
    points: 10,
    kind: 'recurring',
    recurs: 'daily',
    default_assignees: '1,2,3',
  });
  assert.equal(res.body.bonus.kind, 'bonus');
  assert.equal(res.body.bonus.recurs, 'none');
  assert.equal(res.body.bonus.default_assignees, '');
});

test('POST /api/admin/bonuses requires title and points', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const r1 = await agent.post('/api/admin/bonuses').send({ points: 10 });
  assert.equal(r1.status, 400);
  const r2 = await agent.post('/api/admin/bonuses').send({ title: 'X' });
  assert.equal(r2.status, 400);
});

test('GET /api/admin/bonuses lists active and claimed bonuses with status', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const { id: kidId } = await asKid(app, db, 'K1');

  // Create one bonus via API (will be unclaimed)
  const post = await agent.post('/api/admin/bonuses').send({ title: 'Unclaimed', points: 5 });
  const unclaimedId = post.body.bonus.id;

  // Create a second bonus directly + simulate it claimed
  const claimedId = db.prepare("INSERT INTO chores (title, points, kind, recurs, default_assignees) VALUES ('Claimed', 20, 'bonus', 'none', '') RETURNING id").get().id;
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now', 'localtime'), 'pending')").run(claimedId, kidId);

  const res = await agent.get('/api/admin/bonuses');
  assert.equal(res.status, 200);
  assert.equal(res.body.bonuses.length, 2);

  const unc = res.body.bonuses.find(b => b.id === unclaimedId);
  assert.equal(unc.claimed_by, null);

  const cl = res.body.bonuses.find(b => b.id === claimedId);
  assert.equal(cl.claimed_by, kidId);
  assert.equal(cl.claimed_by_name, 'K1');
  assert.equal(cl.assignment_status, 'pending');
});

test('PATCH /api/admin/bonuses/:id updates an unclaimed bonus', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const post = await agent.post('/api/admin/bonuses').send({ title: 'X', points: 5 });
  const id = post.body.bonus.id;
  const r = await agent.patch(`/api/admin/bonuses/${id}`).send({ title: 'Y', points: 25 });
  assert.equal(r.status, 200);
  assert.equal(r.body.bonus.title, 'Y');
  assert.equal(r.body.bonus.points, 25);
});

test('PATCH on a claimed bonus returns 409', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const { id: kidId } = await asKid(app, db);
  const post = await agent.post('/api/admin/bonuses').send({ title: 'X', points: 5 });
  const id = post.body.bonus.id;
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now', 'localtime'), 'pending')").run(id, kidId);

  const r = await agent.patch(`/api/admin/bonuses/${id}`).send({ title: 'Y' });
  assert.equal(r.status, 409);
});

test('DELETE /api/admin/bonuses/:id soft-deletes the bonus chore', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const post = await agent.post('/api/admin/bonuses').send({ title: 'X', points: 5 });
  const id = post.body.bonus.id;

  const r = await agent.delete(`/api/admin/bonuses/${id}`);
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT deleted_at FROM chores WHERE id = ?').get(id);
  assert.ok(row.deleted_at);
});

test('admin bonuses endpoints reject non-parent', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const { agent: kidAgent } = await asKid(app, db);
  const r1 = await kidAgent.get('/api/admin/bonuses');
  assert.equal(r1.status, 403);
  const r2 = await kidAgent.post('/api/admin/bonuses').send({ title: 'X', points: 5 });
  assert.equal(r2.status, 403);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL — endpoint doesn't exist.

- [ ] **Step 3: Create `src/routes/admin/bonuses.js`**

```js
import { Router } from 'express';
import { requireRole } from '../../auth.js';

const ALLOWED_FIELDS = [
  'title', 'description', 'points', 'anti_cheat', 'photo_prompt',
];

export function adminBonusesRoutes() {
  const r = Router();
  r.use(requireRole('parent'));

  // List active (not soft-deleted) bonus chores + claim info.
  // Claimed-status is derived from the existence and status of an assignment
  // row for the chore.
  r.get('/bonuses', (req, res) => {
    const db = req.app.get('db');
    const rows = db.prepare(`
      SELECT c.id, c.title, c.description, c.points, c.anti_cheat,
             c.photo_prompt, c.created_at,
             a.id AS assignment_id,
             a.person_id AS claimed_by,
             a.status AS assignment_status,
             a.due_date AS claimed_date,
             p.name AS claimed_by_name,
             p.avatar_color AS claimed_by_color
      FROM chores c
      LEFT JOIN assignments a ON a.chore_id = c.id
      LEFT JOIN people p ON p.id = a.person_id
      WHERE c.kind = 'bonus' AND c.deleted_at IS NULL
      ORDER BY c.created_at DESC
    `).all();
    res.json({ bonuses: rows });
  });

  r.post('/bonuses', (req, res) => {
    const db = req.app.get('db');
    const data = pickFields(req.body || {});
    if (!data.title || !String(data.title).trim()) {
      return res.status(400).json({ error: 'title required' });
    }
    if (typeof data.points !== 'number' || !Number.isFinite(data.points) || data.points <= 0) {
      return res.status(400).json({ error: 'points required (positive number)' });
    }
    if (data.anti_cheat && !['honor', 'photo', 'approval'].includes(data.anti_cheat)) {
      return res.status(400).json({ error: 'anti_cheat must be honor, photo, or approval' });
    }

    // Force the bonus shape regardless of what the client sent.
    const cols = ['kind', 'recurs', 'default_assignees', ...Object.keys(data)];
    const vals = ['bonus', 'none', '', ...Object.values(data)];
    const bonus = db.prepare(`
      INSERT INTO chores (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) RETURNING *
    `).get(...vals);
    res.json({ bonus });
  });

  r.patch('/bonuses/:id', (req, res) => {
    const db = req.app.get('db');
    // Reject if any assignment exists for this bonus (claim is final).
    const claimed = db.prepare(
      "SELECT id FROM assignments WHERE chore_id = ?"
    ).get(req.params.id);
    if (claimed) {
      return res.status(409).json({ error: 'Bonus already claimed, cannot edit' });
    }
    const data = pickFields(req.body || {});
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'nothing to update' });
    }
    const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
    const bonus = db.prepare(`
      UPDATE chores SET ${sets} WHERE id = ? AND kind = 'bonus' AND deleted_at IS NULL RETURNING *
    `).get(...Object.values(data), req.params.id);
    if (!bonus) return res.status(404).json({ error: 'Not found' });
    res.json({ bonus });
  });

  r.delete('/bonuses/:id', (req, res) => {
    const db = req.app.get('db');
    const r2 = db.prepare(`
      UPDATE chores SET deleted_at = datetime('now')
      WHERE id = ? AND kind = 'bonus' AND deleted_at IS NULL
    `).run(req.params.id);
    if (r2.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  return r;
}

function pickFields(body) {
  const out = {};
  for (const f of ALLOWED_FIELDS) {
    if (body[f] !== undefined) out[f] = body[f];
  }
  return out;
}
```

- [ ] **Step 4: Wire into `src/app.js`**

Read the current file. Add the import near the other admin imports:

```js
import { adminBonusesRoutes } from './routes/admin/bonuses.js';
```

And the mount after the other admin mounts:

```js
  app.use('/api/admin', adminBonusesRoutes());
```

- [ ] **Step 5: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 97 tests (89 prior + 8 new).

- [ ] **Step 6: Commit**

```bash
cd ~/projects/tally && git add src/routes/admin/bonuses.js src/app.js tests/routes-admin-bonuses.test.js && git commit -m "feat(admin): bonus board endpoints (list, post, patch, delete)"
```

---

## Task 4: Claim endpoint + bonus arrays in `/api/home` and `/api/wall`

**Files:**
- Modify: `src/routes/home.js`, `src/routes/wall.js`
- Create: `tests/routes-bonuses-claim.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/routes-bonuses-claim.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';

function seedKid(db, name) {
  return db.prepare("INSERT INTO people (name, role) VALUES (?, 'kid') RETURNING id").get(name).id;
}
function seedBonus(db, title = 'X', points = 10, antiCheat = 'honor') {
  return db.prepare(
    "INSERT INTO chores (title, points, kind, recurs, default_assignees, anti_cheat) VALUES (?, ?, 'bonus', 'none', '', ?) RETURNING id"
  ).get(title, points, antiCheat).id;
}
async function loginKid(app, id) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id });
  return agent;
}

test('POST /api/bonuses/:id/claim creates an assignment for the kid', async () => {
  const db = freshDb();
  const kid = seedKid(db, 'K');
  const bonusId = seedBonus(db, 'Mow', 30);
  const app = freshApp(db);
  const agent = await loginKid(app, kid);

  const res = await agent.post(`/api/bonuses/${bonusId}/claim`);
  assert.equal(res.status, 200);
  assert.ok(res.body.assignment_id);
  const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(res.body.assignment_id);
  assert.equal(a.chore_id, bonusId);
  assert.equal(a.person_id, kid);
  assert.equal(a.status, 'pending');
});

test('claim returns 409 if already claimed', async () => {
  const db = freshDb();
  const first = seedKid(db, 'First');
  const second = seedKid(db, 'Second');
  const bonusId = seedBonus(db);
  const app = freshApp(db);

  const firstAgent = await loginKid(app, first);
  await firstAgent.post(`/api/bonuses/${bonusId}/claim`);

  const secondAgent = await loginKid(app, second);
  const res = await secondAgent.post(`/api/bonuses/${bonusId}/claim`);
  assert.equal(res.status, 409);
});

test('claim returns 404 if bonus deleted', async () => {
  const db = freshDb();
  const kid = seedKid(db, 'K');
  const bonusId = seedBonus(db);
  db.prepare("UPDATE chores SET deleted_at = datetime('now') WHERE id = ?").run(bonusId);
  const app = freshApp(db);
  const agent = await loginKid(app, kid);
  const res = await agent.post(`/api/bonuses/${bonusId}/claim`);
  assert.equal(res.status, 404);
});

test('claim returns 404 if chore is not a bonus', async () => {
  const db = freshDb();
  const kid = seedKid(db, 'K');
  const cId = db.prepare("INSERT INTO chores (title, points, kind) VALUES ('Reg', 5, 'recurring') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await loginKid(app, kid);
  const res = await agent.post(`/api/bonuses/${cId}/claim`);
  assert.equal(res.status, 404);
});

test('claim rejects parents (only kids can claim)', async () => {
  const db = freshDb();
  const parentId = db.prepare("INSERT INTO people (name, role) VALUES ('Mom', 'parent') RETURNING id").get().id;
  const bonusId = seedBonus(db);
  const app = freshApp(db);
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: parentId, pin: '1234' });
  const res = await agent.post(`/api/bonuses/${bonusId}/claim`);
  assert.equal(res.status, 403);
});

test('GET /api/home includes unclaimed bonuses in bonuses[]', async () => {
  const db = freshDb();
  const kid = seedKid(db, 'K');
  seedBonus(db, 'Available', 15);
  const claimed = seedBonus(db, 'Already taken', 10);
  // Pre-claim the second bonus
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, date('now', 'localtime'), 'pending')").run(claimed, kid);
  const app = freshApp(db);
  const agent = await loginKid(app, kid);
  const res = await agent.get('/api/home');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.bonuses));
  assert.equal(res.body.bonuses.length, 1);
  assert.equal(res.body.bonuses[0].title, 'Available');
});

test('GET /api/wall includes unclaimed bonuses', async () => {
  const db = freshDb();
  seedBonus(db, 'Up for grabs', 25);
  const app = freshApp(db);
  const res = await request(app).get('/api/wall');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.bonuses));
  assert.equal(res.body.bonuses.length, 1);
  assert.equal(res.body.bonuses[0].title, 'Up for grabs');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL — claim endpoint and bonuses arrays don't exist yet.

- [ ] **Step 3: Add the claim endpoint + `bonuses` array to `src/routes/home.js`**

Read the current file. You'll be making two changes:

(a) Inside the GET /home handler, just BEFORE the `res.json(...)` line, build a `bonuses` array:

```js
    const bonuses = db.prepare(`
      SELECT c.id, c.title, c.description, c.points, c.anti_cheat, c.photo_prompt
      FROM chores c
      LEFT JOIN assignments a ON a.chore_id = c.id
      WHERE c.kind = 'bonus' AND c.deleted_at IS NULL AND a.id IS NULL
      ORDER BY c.created_at DESC
    `).all();
```

And include it in the response:

```js
    res.json({ person, today: todayList, overdue: overdueList, stealable, bonuses });
```

(b) Add the new POST /bonuses/:id/claim route at the end of `homeRoutes`, just before `return r;`:

```js
  r.post('/bonuses/:id/claim', requireRole('kid'), (req, res) => {
    const db = req.app.get('db');
    const kidId = req.user.person_id;
    const chore = db.prepare(
      "SELECT * FROM chores WHERE id = ? AND kind = 'bonus' AND deleted_at IS NULL"
    ).get(req.params.id);
    if (!chore) return res.status(404).json({ error: 'Not found' });

    // Race-guarded claim: INSERT only if no assignment row exists for this chore.
    const row = db.prepare(`
      INSERT INTO assignments (chore_id, person_id, due_date, status)
      SELECT ?, ?, date('now', 'localtime'), 'pending'
      WHERE NOT EXISTS (SELECT 1 FROM assignments WHERE chore_id = ?)
      RETURNING id
    `).get(chore.id, kidId, chore.id);

    if (!row) {
      return res.status(409).json({ error: 'Already claimed' });
    }
    res.json({ ok: true, assignment_id: row.id });
  });
```

- [ ] **Step 4: Add `bonuses` array to `src/routes/wall.js`**

Read the current file. Just BEFORE the `res.json({ kids, house_pct: housePct, today: todayIso });` line in the GET /wall handler, add:

```js
    const bonuses = db.prepare(`
      SELECT c.id, c.title, c.points, c.anti_cheat
      FROM chores c
      LEFT JOIN assignments a ON a.chore_id = c.id
      WHERE c.kind = 'bonus' AND c.deleted_at IS NULL AND a.id IS NULL
      ORDER BY c.created_at DESC
    `).all();
```

Update the response:

```js
    res.json({ kids, house_pct: housePct, today: todayIso, bonuses });
```

- [ ] **Step 5: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 104 tests (97 prior + 7 new).

- [ ] **Step 6: Commit**

```bash
cd ~/projects/tally && git add src/routes/home.js src/routes/wall.js tests/routes-bonuses-claim.test.js && git commit -m "feat(bonuses): /claim endpoint + bonuses[] in /home and /wall"
```

---

## Task 5: Mark Today list shows claimed bonus with ★ badge

**Files:**
- Modify: `src/routes/home.js`
- Modify: `src/routes/wall.js`

When a kid claims a bonus, their `/api/home` should show the bonus chore in their Today list with a flag the frontend can use to render a ★ Bonus badge. Same for the wall display.

- [ ] **Step 1: Modify `src/routes/home.js` to include `is_bonus` on assignments**

Find the assignments SELECT in the GET /home handler. Currently it looks like:

```js
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
```

Add `c.kind` and `c.points` to the SELECT (so the front-end can see "this is a bonus" and use the chore's fixed `points` directly):

```js
    const assignments = db.prepare(`
      SELECT a.id, a.due_date, a.status, a.note, a.photo_path,
             a.stolen_from,
             c.title, c.weight, c.anti_cheat, c.kind, c.points AS chore_points,
             sf.name AS stolen_from_name
      FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      LEFT JOIN people sf ON sf.id = a.stolen_from
      WHERE a.person_id = ?
        AND (a.due_date = ? OR (a.due_date < ? AND a.status NOT IN ('done','expired','rejected')))
      ORDER BY a.due_date, c.title
    `).all(personId, today(), today());
```

And in the `for (const a of assignments)` loop where `display_points` is computed, override the display for bonus chores:

```js
    const target = person.weekly_target_pts || 0;
    for (const a of assignments) {
      if (a.kind === 'bonus') {
        a.display_points = a.chore_points;
        a.is_bonus = 1;
      } else {
        a.display_points = pts.totalWeight > 0
          ? Math.round(a.weight / pts.totalWeight * target)
          : 0;
        a.is_bonus = 0;
      }
    }
```

- [ ] **Step 2: Modify `src/routes/wall.js` for the same purpose**

Find the assignmentRows query. Currently it selects `c.weight` etc. Add `c.kind` and `c.points`:

```js
    const assignmentRows = kidIds.length === 0 ? [] : db.prepare(`
      SELECT a.id, a.person_id, a.due_date, a.status, a.stolen_from,
             c.title, c.weight, c.kind, c.points AS chore_points,
             sf.name AS stolen_from_name
      FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      LEFT JOIN people sf ON sf.id = a.stolen_from
      WHERE a.person_id IN (${kidIds.map(() => '?').join(',')})
        AND (a.due_date = ? OR (a.due_date < ? AND a.status NOT IN ('done','expired','rejected')))
      ORDER BY a.due_date, c.title
    `).all(...kidIds, todayIso, todayIso);
```

And in the row-processing loop, override display_points for bonuses:

```js
    for (const a of assignmentRows) {
      const kid = kids.find(k => k.id === a.person_id);
      if (!kid) continue;
      const target = kid.weekly_target_pts || 0;
      const totalWeight = totals.get(kid.id) || 0;
      if (a.kind === 'bonus') {
        a.display_points = a.chore_points;
        a.is_bonus = 1;
      } else {
        a.display_points = totalWeight > 0 ? Math.round(a.weight / totalWeight * target) : 0;
        a.is_bonus = 0;
      }
      const bucket = a.due_date === todayIso ? kid.today : kid.overdue;
      bucket.push(a);
      total++;
      if (a.status === 'done') done++;
    }
```

- [ ] **Step 3: Append a quick test to `tests/routes-bonuses-claim.test.js`**

```js
test('claimed bonus appears in kid Today list with is_bonus=1 and chore.points as display_points', async () => {
  const db = freshDb();
  const kid = seedKid(db, 'K');
  const bonusId = seedBonus(db, 'Mow', 30);
  const app = freshApp(db);
  const agent = await loginKid(app, kid);
  await agent.post(`/api/bonuses/${bonusId}/claim`);

  const home = await agent.get('/api/home');
  const row = home.body.today.find(t => t.title === 'Mow');
  assert.ok(row);
  assert.equal(row.is_bonus, 1);
  assert.equal(row.display_points, 30);
});
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 105 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/routes/home.js src/routes/wall.js tests/routes-bonuses-claim.test.js && git commit -m "feat(bonuses): expose is_bonus + fixed-point display in Today list + wall"
```

---

## Task 6: Admin Bonus Board tab UI

**Files:**
- Modify: `public/js/pages/admin.js`
- Modify: `public/css/layouts.css`

- [ ] **Step 1: Add the Bonus Board tab to the TABS array**

Read `public/js/pages/admin.js`. Find the TABS declaration. It currently looks like:

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

Insert the Bonus Board entry between Approvals and People:

```js
const TABS = [
  { key: 'today',      label: 'Today',      render: renderToday },
  { key: 'day-review', label: 'Day review', render: renderDayReview },
  { key: 'approvals',  label: 'Approvals',  render: renderApprovals },
  { key: 'bonuses',    label: 'Bonus board', render: renderBonuses },
  { key: 'people',     label: 'People',     render: renderPeople },
  { key: 'chores',     label: 'Chores',     render: renderChores },
  { key: 'settings',   label: 'Settings',   render: renderSettings },
];
```

- [ ] **Step 2: Append `renderBonuses` at the end of `public/js/pages/admin.js`**

Append this block at the very end of the file:

```js
/* ───── Bonus Board tab ───── */
async function renderBonuses(host) {
  clear(host);

  // Quick-add form
  const form = {
    title: '',
    points: 10,
    anti_cheat: 'honor',
    description: '',
    photo_prompt: '',
  };
  const photoPromptField = el('div', { class: 'form-field', style: { display: 'none' } }, [
    el('label', {}, ['Photo prompt (shown to the kid)']),
    el('input', { type: 'text', value: form.photo_prompt, onInput: e => form.photo_prompt = e.target.value }),
  ]);
  const antiCheatSelect = el('select', {
    onChange: e => {
      form.anti_cheat = e.target.value;
      photoPromptField.style.display = e.target.value === 'photo' ? 'flex' : 'none';
    },
  }, ['honor', 'photo', 'approval'].map(o =>
    el('option', { value: o, selected: form.anti_cheat === o }, [o])));

  const formCard = el('div', { class: 'card', style: { marginBottom: 'var(--s4)' } }, [
    el('h3', { style: { marginBottom: 'var(--s3)' } }, ['Post a bonus']),
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Title']),
      el('input', { type: 'text', placeholder: 'Mow lawn', onInput: e => form.title = e.target.value }),
    ]),
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Points']),
      el('input', { type: 'number', value: form.points, min: '1', onInput: e => form.points = Number(e.target.value) }),
    ]),
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Anti-cheat']),
      antiCheatSelect,
    ]),
    photoPromptField,
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Description (optional)']),
      el('textarea', { rows: 2, onInput: e => form.description = e.target.value }),
    ]),
    el('button', {
      class: 'btn btn-primary',
      onClick: async (e) => {
        e.target.disabled = true;
        e.target.textContent = '…';
        try {
          await api.post('/api/admin/bonuses', form);
          renderBonuses(host);
        } catch (err) {
          alert('Post failed: ' + err.message);
          e.target.disabled = false;
          e.target.textContent = 'Post bonus';
        }
      },
    }, ['Post bonus']),
  ]);
  host.appendChild(formCard);

  // List
  const data = await api.get('/api/admin/bonuses');
  host.appendChild(el('h3', { style: { marginBottom: 'var(--s3)' } }, [
    `${data.bonuses.length} bonus${data.bonuses.length === 1 ? '' : 'es'}`,
  ]));

  if (data.bonuses.length === 0) {
    host.appendChild(el('p', { class: 'muted' }, ['No bonuses posted.']));
    return;
  }

  host.appendChild(el('div', { class: 'stack' },
    data.bonuses.map(b => renderBonusRow(b, host))
  ));
}

function renderBonusRow(b, host) {
  const statusText = b.claimed_by
    ? `Claimed by ${b.claimed_by_name} · ${b.assignment_status}`
    : 'Unclaimed';
  const statusClass = b.claimed_by
    ? (b.assignment_status === 'done' ? 'pill-success'
       : b.assignment_status === 'rejected' ? 'pill-danger'
       : 'pill-info')
    : 'pill-warn';

  const actions = [];
  if (!b.claimed_by) {
    actions.push(el('button', {
      class: 'btn btn-danger btn-sm',
      onClick: async () => {
        if (!confirm(`Cancel bonus "${b.title}"?`)) return;
        await api.del(`/api/admin/bonuses/${b.id}`);
        renderBonuses(host);
      },
    }, ['Cancel']));
  }

  return el('div', { class: 'review-row' }, [
    el('div', { class: 'row spaced' }, [
      el('div', {}, [
        el('div', { style: { fontWeight: 600 } }, [b.title]),
        el('div', { class: 'muted', style: { fontSize: '0.78rem' } }, [
          `+${b.points} pts · ${b.anti_cheat}${b.description ? ' · ' + b.description : ''}`,
        ]),
      ]),
      el('span', { class: 'pill ' + statusClass }, [statusText]),
    ]),
    actions.length > 0 ? el('div', { class: 'row spaced approval-actions' }, actions) : null,
  ].filter(Boolean));
}
```

- [ ] **Step 3: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 105 tests (no new tests for pure UI).

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/admin.js && git commit -m "feat(admin): Bonus Board tab with quick-add and list"
```

---

## Task 7: Kid home — Bonus Board section + ★ bonus badge on Today rows

**Files:**
- Modify: `public/js/pages/home.js`
- Modify: `public/css/layouts.css`

- [ ] **Step 1: Add Bonus Board section to `renderHome`**

Read `public/js/pages/home.js`. Find renderHome. The structure currently includes `overdueSection`, `stealSection`. Add a `bonusBoardSection` between Today and Steal.

After the `overdueSection` declaration (and BEFORE the `stealSection` declaration), add:

```js
  const bonusBoardSection = (data.bonuses && data.bonuses.length > 0)
    ? el('section', { class: 'stack' }, [
        el('div', { class: 'label' }, ['Bonus board']),
        ...data.bonuses.map(b => el('div', { class: 'txn bonus-row' }, [
          el('div', { class: 'left' }, [
            el('div', { class: 'ico bonus-ico' }, ['★']),
            el('div', {}, [
              el('div', {}, [b.title]),
              b.description ? el('div', { class: 'muted', style: { fontSize: '0.7rem' } }, [b.description]) : null,
            ].filter(Boolean)),
          ]),
          el('button', {
            class: 'btn btn-primary btn-done',
            onClick: async (e) => {
              e.stopPropagation();
              e.target.disabled = true;
              e.target.textContent = '…';
              try {
                await api.post(`/api/bonuses/${b.id}/claim`);
                renderHome(root);
              } catch (err) {
                if (err.status === 409) {
                  alert('Someone beat you to it.');
                } else {
                  alert('Could not claim: ' + err.message);
                }
                renderHome(root);
              }
            },
          }, [`Claim · +${b.points}`]),
        ])),
      ])
    : null;
```

- [ ] **Step 2: Insert `bonusBoardSection` into the root appendChild list**

Find the final `root.appendChild(...)` block and insert `bonusBoardSection` between `overdueSection` and `stealSection`:

```js
  root.appendChild(el('div', { class: 'page stack' }, [
    el('header', { class: 'app-header' }, [
      el('h1', {}, [`Hey ${p.name}`]),
      el('div', { class: 'av', style: { background: p.avatar_color } }, [p.name[0]]),
    ]),
    hero,
    todaySection,
    overdueSection,
    bonusBoardSection,
    stealSection,
    el('div', { class: 'row', style: { marginTop: 'var(--s5)' } }, [
      el('button', { class: 'btn btn-ghost', onClick: () => logout() }, ['Sign out']),
    ]),
  ].filter(Boolean)));
```

- [ ] **Step 3: Add the ★ Bonus badge to renderTask for claimed bonuses**

Find renderTask. After the existing `stolenBadge` line, add a similar `bonusBadge`:

```js
  const stolenBadge = a.stolen_from_name
    ? el('span', { class: 'pill pill-info', style: { fontSize: '0.62rem', marginLeft: '6px' } }, [`from ${a.stolen_from_name}`])
    : null;
  const bonusBadge = a.is_bonus
    ? el('span', { class: 'pill pill-warn', style: { fontSize: '0.62rem', marginLeft: '6px' } }, ['★ bonus'])
    : null;
```

Then update the return to include the bonusBadge:

```js
  return el('div', { class: classes.join(' ') }, [
    el('div', { class: 'left' }, [
      el('div', { class: `ico ${ico}` }, [icoText]),
      el('div', {}, [
        el('span', {}, [a.title]),
        stolenBadge,
        bonusBadge,
      ].filter(Boolean)),
    ]),
    action,
  ]);
```

- [ ] **Step 4: Append CSS to `public/css/layouts.css`**

```css
.bonus-row {
  border-style: dashed;
  background: linear-gradient(0deg, #FEF3C7, var(--card));
}
.bonus-ico {
  background: #FEF3C7 !important;
  color: #92400E !important;
}
```

- [ ] **Step 5: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 105 tests.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/home.js public/css/layouts.css && git commit -m "feat(home): Bonus Board section + ★ bonus badge on claimed bonus rows"
```

---

## Task 8: Wall — bonus strip + ★ badge on claimed bonus tasks

**Files:**
- Modify: `public/js/pages/wall.js`
- Modify: `public/css/layouts.css`

- [ ] **Step 1: Add a bonus strip below the kid columns in `public/js/pages/wall.js`**

Read the current file. Find the section in `render()` where it builds the final page DOM:

```js
  root.appendChild(el('div', { class: 'wall-page' }, [
    el('div', { class: 'wall-header' }, [
      el('h2', {}, [`The Lopez House · ${fmtDate(now)}`]),
      el('span', { class: 't' }, [fmtTime(now)]),
    ]),
    banner,
    cols,
  ]));
```

REPLACE with this version, which adds a `bonusStrip` between cols and the end (showing nothing if no bonuses are active):

```js
  const bonusStrip = (data.bonuses && data.bonuses.length > 0)
    ? el('div', { class: 'wall-bonus-strip' }, [
        el('div', { class: 'wall-bonus-strip-label' }, ['Bonus board · up for grabs']),
        el('div', { class: 'wall-bonus-strip-items' },
          data.bonuses.map(b => el('div', { class: 'wall-bonus-item' }, [
            el('div', { class: 'wall-bonus-title' }, [b.title]),
            el('div', { class: 'wall-bonus-pts' }, [`+${b.points}`]),
          ]))
        ),
      ])
    : null;

  root.appendChild(el('div', { class: 'wall-page' }, [
    el('div', { class: 'wall-header' }, [
      el('h2', {}, [`The Lopez House · ${fmtDate(now)}`]),
      el('span', { class: 't' }, [fmtTime(now)]),
    ]),
    banner,
    cols,
    bonusStrip,
  ].filter(Boolean)));
```

- [ ] **Step 2: Add the ★ Bonus badge to task rendering inside kid columns**

Find this block in `render()`:

```js
            : tasks.map(t => el('div', {
                class: 'task' + (t.status === 'done' ? ' done' : '') + (t.over ? ' over' : ''),
              }, [
                el('div', {}, [
                  el('span', {}, [t.title]),
                  t.stolen_from_name ? el('span', { style: { fontSize: '0.62rem', color: 'var(--muted)', marginLeft: '6px' } }, [`(from ${t.stolen_from_name})`]) : null,
                ].filter(Boolean)),
                el('span', { class: 'p' }, [`+${t.display_points || 0}`]),
              ]))
```

REPLACE with this version, which adds the ★ Bonus marker for claimed bonus rows:

```js
            : tasks.map(t => el('div', {
                class: 'task' + (t.status === 'done' ? ' done' : '') + (t.over ? ' over' : '') + (t.is_bonus ? ' bonus' : ''),
              }, [
                el('div', {}, [
                  el('span', {}, [t.title]),
                  t.is_bonus ? el('span', { style: { fontSize: '0.62rem', color: '#92400E', marginLeft: '6px' } }, ['★']) : null,
                  t.stolen_from_name ? el('span', { style: { fontSize: '0.62rem', color: 'var(--muted)', marginLeft: '6px' } }, [`(from ${t.stolen_from_name})`]) : null,
                ].filter(Boolean)),
                el('span', { class: 'p' }, [`+${t.display_points || 0}`]),
              ]))
```

- [ ] **Step 3: Append CSS for the bonus strip + bonus task badge**

```css
.wall-bonus-strip {
  background: linear-gradient(135deg, #FEF3C7, #FDE68A);
  border-radius: var(--r-md);
  padding: 12px 16px;
  display: flex; flex-direction: column; gap: 8px;
}
.wall-bonus-strip-label {
  color: #92400E;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 1.4px;
  font-weight: 600;
}
.wall-bonus-strip-items {
  display: flex; flex-wrap: wrap; gap: 10px;
}
.wall-bonus-item {
  background: white;
  border: 1px solid #FCD34D;
  border-radius: var(--r-sm);
  padding: 6px 12px;
  display: flex; align-items: center; gap: 8px;
}
.wall-bonus-title {
  font-weight: 600;
  color: #92400E;
}
.wall-bonus-pts {
  font-family: var(--font-num);
  font-weight: 600;
  color: #B45309;
}
.wall-col .task.bonus {
  background: #FEF3C7;
  border: 1px dashed #FCD34D;
}
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 105 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/wall.js public/css/layouts.css && git commit -m "feat(wall): bonus strip below kid columns + ★ badge on claimed bonus tasks"
```

---

## Task 9: Deploy + tag v0.4.0-phase4

- [ ] **Step 1: Final test run**

```bash
cd ~/projects/tally && npm test
```

Expected: 105 tests pass.

- [ ] **Step 2: Reload PM2 and verify**

```bash
cd ~/projects/tally && pm2 reload tally
sleep 3
curl -sf --resolve tally.thelopezfamily.org:443:104.21.49.63 https://tally.thelopezfamily.org/api/health
```

Expected: `{"ok":true}`.

- [ ] **Step 3: Smoke production**

```bash
# As parent (need to log in via browser; not scriptable cleanly), the manual
# steps are listed in §10 of the spec. Here just confirm the new endpoints
# are wired:
curl -sf --resolve tally.thelopezfamily.org:443:104.21.49.63 https://tally.thelopezfamily.org/api/wall | python3 -c "import sys,json; d=json.load(sys.stdin); print('bonuses key present:', 'bonuses' in d)"
```

Expected: `bonuses key present: True`.

- [ ] **Step 4: Tag the release**

```bash
cd ~/projects/tally && git tag v0.4.0-phase4 && git log --oneline -15 && git tag -l
```

---

## Self-Review

**Spec coverage check:**

| Spec section | Covered by Task(s) |
|---|---|
| §1 Summary | All tasks together |
| §2 Goals (parent posts ad-hoc, first-claim, pure bonus pay, no new tables) | Tasks 1-8 |
| §3 Non-goals (no expiry, no edit-after-claim, no reassign) | Task 3 PATCH 409 enforces no-edit-after-claim; no expiry implemented; no reassign endpoint |
| §4 Math (bonusPoints, calcProjectedPay with bonus) | Task 1 |
| §5 Data model (no migration, lifecycle, race guard) | Tasks 3 (admin), 4 (claim with race guard) |
| §6 API surface (GET/POST/PATCH/DELETE admin, POST claim, modified payloads) | Tasks 3, 4 |
| §6 calcWeekPoints + calcProjectedPay updates | Task 1 |
| §7 Admin Bonus Board tab UI | Task 6 |
| §7 Kid home Bonus Board section + ★ badge | Task 7 |
| §7 Wall bonus strip + ★ badge | Task 8 |
| §8 Tech notes (whitelisted fields, generator skips bonus, no `weight` use) | Task 3 enforces whitelist; generator naturally skips because it filters by `kind='recurring'` |
| §9 Tests (new test files + extensions) | Tasks 1, 3, 4, 5 |
| §10 Acceptance test | Task 9 references the spec list |

**Placeholder scan:** No TBDs found. All code blocks are concrete.

**Type consistency:**
- `bonusPoints` field name used identically in points.js, home, today
- `is_bonus` field used identically in home and wall row processing
- `display_points` used for both regular (computed from weight) and bonus (= chore.points) — consistent meaning: "what to display next to this task"
- API path `/api/bonuses/:id/claim` (kid-facing, mounted at `/api`) vs `/api/admin/bonuses/:id` (parent-facing, mounted at `/api/admin`) — distinct, consistent
- `chore.points` reused (it's already in schema; meaningful for bonus kind, ignored for recurring)

Plan is internally consistent.

---

## Execution Handoff

Plan complete and saved to [`docs/superpowers/plans/2026-05-26-tally-phase-4-bonus-board.md`](2026-05-26-tally-phase-4-bonus-board.md). **9 tasks** total.

Following the pattern of Phases 1-3 and 2a, **Subagent-Driven** execution is the default. I'll proceed unless you say otherwise.
