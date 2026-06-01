# Tally — Cover for a Frozen Sibling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a sibling claim a frozen kid's excused chores. The chore's ownership transfers to the claimer (status flips back to `pending`, `person_id = claimer`, no `stolen_from` link), so they can complete it normally and earn the points.

**Architecture:** No schema change. `/api/home` gains a `covers` array (excused chores from currently-frozen sibling kids). A new `POST /api/assignments/:id/claim-cover` endpoint validates the situation, then race-safely updates the assignment to transfer ownership. The kid home UI gains a "Cover for a sibling" section rendered just above the existing "Steal from a sibling" section. Reuses `isOnFreeze` from `src/lib/streak.js`.

**Tech Stack:** Node 20 ESM, Express 5, better-sqlite3, vanilla JS. No new dependencies, no migration.

**Spec:** [`docs/superpowers/specs/2026-05-29-tally-cover-for-frozen-sibling-design.md`](../specs/2026-05-29-tally-cover-for-frozen-sibling-design.md)

---

## File Structure

```
~/projects/tally/
├── src/routes/home.js                  MODIFY: add covers payload + claim-cover endpoint
├── public/js/pages/home.js             MODIFY: render "Cover for a sibling" section
└── tests/
    ├── routes-home.test.js             MODIFY: covers payload tests
    └── routes-claim-cover.test.js      NEW: endpoint tests
```

---

## Task 1: Server — covers payload on `/api/home`

**Files:**
- Modify: `src/routes/home.js`
- Modify: `tests/routes-home.test.js`

- [ ] **Step 1: Append failing tests to `tests/routes-home.test.js`**

Read the file first to confirm the imports and helpers (`freshDb`, `freshApp`, `request.agent`, login pattern for a kid). Append at the bottom:

```js
import { isOnFreeze } from '../src/lib/streak.js';
import { today as todayIso } from '../src/lib/dates.js';

test('GET /api/home returns covers for a kid when a sibling is frozen with an excused chore', async () => {
  const db = freshDb();
  const frozen = db.prepare("INSERT INTO people (name, role, avatar_color) VALUES ('Gabriel','kid','#22C55E') RETURNING id").get().id;
  const claimer = db.prepare("INSERT INTO people (name, role, weekly_target_pts) VALUES ('Olivia','kid',100) RETURNING id").get().id;
  const c = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('Walk dogs', 3, 'daily', '') RETURNING id").get().id;
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status, note) VALUES (?, ?, ?, 'excused', 'On freeze')").run(c, frozen, todayIso());
  db.prepare("UPDATE people SET freeze_start = ?, freeze_end = ? WHERE id = ?").run(todayIso(), todayIso(), frozen);

  const app = freshApp(db);
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: claimer });

  const res = await agent.get('/api/home');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.covers));
  assert.equal(res.body.covers.length, 1);
  assert.equal(res.body.covers[0].owner_name, 'Gabriel');
  assert.equal(res.body.covers[0].owner_color, '#22C55E');
  assert.equal(res.body.covers[0].title, 'Walk dogs');
});

test('GET /api/home covers excludes excused chores when the owner is NOT on freeze', async () => {
  const db = freshDb();
  const owner = db.prepare("INSERT INTO people (name, role) VALUES ('Gabriel','kid') RETURNING id").get().id;
  const viewer = db.prepare("INSERT INTO people (name, role) VALUES ('Olivia','kid') RETURNING id").get().id;
  const c = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('T',3,'daily','') RETURNING id").get().id;
  // Excused, but owner NOT on freeze (e.g., parent-excused individual chore)
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, 'excused')").run(c, owner, todayIso());

  const app = freshApp(db);
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: viewer });
  const res = await agent.get('/api/home');
  assert.equal(res.body.covers.length, 0);
});

test('GET /api/home covers excludes the viewer\'s own excused chores', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const c = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('T',3,'daily','') RETURNING id").get().id;
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, 'excused')").run(c, kid, todayIso());
  db.prepare("UPDATE people SET freeze_start = ?, freeze_end = ? WHERE id = ?").run(todayIso(), todayIso(), kid);

  const app = freshApp(db);
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: kid });
  const res = await agent.get('/api/home');
  assert.equal(res.body.covers.length, 0); // can't cover for yourself
});

test('GET /api/home covers excludes bonus-kind chores', async () => {
  const db = freshDb();
  const frozen = db.prepare("INSERT INTO people (name, role) VALUES ('Gabriel','kid') RETURNING id").get().id;
  const claimer = db.prepare("INSERT INTO people (name, role) VALUES ('Olivia','kid') RETURNING id").get().id;
  const c = db.prepare("INSERT INTO chores (title, points, kind, recurs, default_assignees) VALUES ('Mow', 10, 'bonus', 'none', '') RETURNING id").get().id;
  db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, 'excused')").run(c, frozen, todayIso());
  db.prepare("UPDATE people SET freeze_start = ?, freeze_end = ? WHERE id = ?").run(todayIso(), todayIso(), frozen);

  const app = freshApp(db);
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: claimer });
  const res = await agent.get('/api/home');
  assert.equal(res.body.covers.length, 0);
});
```

The existing file already imports `test`, `assert`, `request`, `freshApp`, `freshDb`. If `isOnFreeze` or `today` are not already imported, add them as shown. Skip the import if already present.

- [ ] **Step 2: Run to verify failure**

```bash
cd ~/projects/tally && node --test tests/routes-home.test.js
```

Expected: FAIL — `res.body.covers` is `undefined`.

- [ ] **Step 3: Modify `src/routes/home.js`**

(a) Add the import alongside the other `lib` imports at the top of the file:

```js
import { currentStreak, streakAtRisk, isOnFreeze } from '../lib/streak.js';
```

The file already imports `currentStreak, streakAtRisk, isOnFreeze` from streak.js — if so, no change here. If `isOnFreeze` is NOT in that import list yet (unlikely given prior phases), add it. Verify by reading the imports first.

(b) Inside the GET /home handler, AFTER the existing `stealable` block (where the loop sets `s.display_points`) and BEFORE the `todayList`/`overdueList` filter lines, add the covers computation:

```js
    const coverRows = db.prepare(`
      SELECT a.id, a.person_id AS owner_id, a.due_date,
             c.title, c.weight, c.anti_cheat,
             p.name AS owner_name, p.avatar_color AS owner_color
      FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      JOIN people p ON p.id = a.person_id
      WHERE a.status = 'excused'
        AND a.person_id != ?
        AND p.role = 'kid'
        AND c.kind != 'bonus'
      ORDER BY p.name, c.title
    `).all(personId);
    const covers = coverRows
      .filter(r => isOnFreeze(db, r.owner_id, r.due_date))
      .map(r => ({
        id: r.id,
        title: r.title,
        weight: r.weight,
        anti_cheat: r.anti_cheat,
        owner_id: r.owner_id,
        owner_name: r.owner_name,
        owner_color: r.owner_color,
        display_points: pts.totalWeight > 0
          ? Math.round(r.weight / pts.totalWeight * target)
          : 0,
      }));
```

(c) Add `covers` to the JSON response. Find:

```js
    res.json({ person, today: todayList, overdue: overdueList, stealable, bonuses });
```

Change to:

```js
    res.json({ person, today: todayList, overdue: overdueList, stealable, bonuses, covers });
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && node --test tests/routes-home.test.js && npm test 2>&1 | grep -E "# (tests|pass|fail)"
```

Expected: routes-home passes; full suite green at 196 (192 prior + 4 new), 0 fail.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/routes/home.js tests/routes-home.test.js && git commit -m "feat(home): expose covers (frozen siblings' excused chores) to other kids"
```

---

## Task 2: `POST /api/assignments/:id/claim-cover`

**Files:**
- Modify: `src/routes/home.js`
- Create: `tests/routes-claim-cover.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/routes-claim-cover.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';
import { today } from '../src/lib/dates.js';

async function loginKid(app, id) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id });
  return agent;
}
function seedFrozenWithExcusedChore(db, ownerName = 'Owner', choreKind = 'recurring') {
  const owner = db.prepare("INSERT INTO people (name, role) VALUES (?, 'kid') RETURNING id").get(ownerName).id;
  const c = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees, kind) VALUES ('Walk dogs', 3, 'daily', '', ?) RETURNING id").get(choreKind).id;
  const aId = db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status, note) VALUES (?, ?, ?, 'excused', 'On freeze') RETURNING id").get(c, owner, today()).id;
  db.prepare("UPDATE people SET freeze_start = ?, freeze_end = ? WHERE id = ?").run(today(), today(), owner);
  return { owner, aId };
}

test('claim-cover transfers ownership cleanly', async () => {
  const db = freshDb();
  const { aId } = seedFrozenWithExcusedChore(db);
  const claimer = db.prepare("INSERT INTO people (name, role) VALUES ('Olivia','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await loginKid(app, claimer);

  const res = await agent.post(`/api/assignments/${aId}/claim-cover`);
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT * FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.person_id, claimer);
  assert.equal(row.status, 'pending');
  assert.equal(row.note, '');
  assert.equal(row.stolen_from, null);
});

test('claim-cover returns 404 if assignment does not exist', async () => {
  const db = freshDb();
  const claimer = db.prepare("INSERT INTO people (name, role) VALUES ('Olivia','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await loginKid(app, claimer);
  const res = await agent.post('/api/assignments/9999/claim-cover');
  assert.equal(res.status, 404);
});

test('claim-cover returns 409 if assignment is not excused', async () => {
  const db = freshDb();
  const owner = db.prepare("INSERT INTO people (name, role) VALUES ('Owner','kid') RETURNING id").get().id;
  const c = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('T', 3, 'daily', '') RETURNING id").get().id;
  const aId = db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, 'pending') RETURNING id").get(c, owner, today()).id;
  db.prepare("UPDATE people SET freeze_start = ?, freeze_end = ? WHERE id = ?").run(today(), today(), owner);
  const claimer = db.prepare("INSERT INTO people (name, role) VALUES ('Olivia','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await loginKid(app, claimer);
  const res = await agent.post(`/api/assignments/${aId}/claim-cover`);
  assert.equal(res.status, 409);
});

test('claim-cover returns 400 if owner is NOT on freeze', async () => {
  const db = freshDb();
  const owner = db.prepare("INSERT INTO people (name, role) VALUES ('Owner','kid') RETURNING id").get().id;
  const c = db.prepare("INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('T', 3, 'daily', '') RETURNING id").get().id;
  // Excused but owner not on freeze (e.g., parent-excused individually)
  const aId = db.prepare("INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, 'excused') RETURNING id").get(c, owner, today()).id;
  const claimer = db.prepare("INSERT INTO people (name, role) VALUES ('Olivia','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await loginKid(app, claimer);
  const res = await agent.post(`/api/assignments/${aId}/claim-cover`);
  assert.equal(res.status, 400);
});

test('claim-cover returns 403 if claimer tries to claim their own excused chore', async () => {
  const db = freshDb();
  const { owner, aId } = seedFrozenWithExcusedChore(db);
  const app = freshApp(db);
  const agent = await loginKid(app, owner); // logging in as the owner of the chore
  const res = await agent.post(`/api/assignments/${aId}/claim-cover`);
  assert.equal(res.status, 403);
});

test('claim-cover returns 400 for a bonus-kind chore', async () => {
  const db = freshDb();
  const { aId } = seedFrozenWithExcusedChore(db, 'Owner', 'bonus');
  const claimer = db.prepare("INSERT INTO people (name, role) VALUES ('Olivia','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await loginKid(app, claimer);
  const res = await agent.post(`/api/assignments/${aId}/claim-cover`);
  assert.equal(res.status, 400);
});

test('claim-cover second concurrent claim returns 409 (race-safe)', async () => {
  const db = freshDb();
  const { aId } = seedFrozenWithExcusedChore(db);
  const first = db.prepare("INSERT INTO people (name, role) VALUES ('First','kid') RETURNING id").get().id;
  const second = db.prepare("INSERT INTO people (name, role) VALUES ('Second','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const firstAgent = await loginKid(app, first);
  await firstAgent.post(`/api/assignments/${aId}/claim-cover`); // wins
  const secondAgent = await loginKid(app, second);
  const res = await secondAgent.post(`/api/assignments/${aId}/claim-cover`);
  assert.equal(res.status, 409);
});

test('claim-cover rejects parents (kid-only)', async () => {
  const db = freshDb();
  const { aId } = seedFrozenWithExcusedChore(db);
  const parentId = db.prepare("INSERT INTO people (name, role) VALUES ('Mom','parent') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: parentId, pin: '1234' });
  const res = await agent.post(`/api/assignments/${aId}/claim-cover`);
  assert.equal(res.status, 403);
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd ~/projects/tally && node --test tests/routes-claim-cover.test.js
```

Expected: FAIL — the route doesn't exist yet (404s on all).

- [ ] **Step 3: Add the endpoint in `src/routes/home.js`**

Find the existing `r.post('/bonuses/:id/claim', ...)` route. Insert this new route immediately after it (it's a kid-only route, parallel pattern):

```js
  r.post('/assignments/:id/claim-cover', requireRole('kid'), (req, res) => {
    const db = req.app.get('db');
    const claimerId = req.user.person_id;
    const a = db.prepare(`
      SELECT a.id, a.person_id, a.due_date, a.status, c.kind, p.role
      FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      JOIN people p ON p.id = a.person_id
      WHERE a.id = ?
    `).get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.status !== 'excused') return res.status(409).json({ error: 'Not available to cover' });
    if (a.kind === 'bonus') return res.status(400).json({ error: 'Bonus chores cannot be covered' });
    if (a.role !== 'kid' || a.person_id === claimerId) {
      return res.status(403).json({ error: 'Cannot cover this chore' });
    }
    if (!isOnFreeze(db, a.person_id, a.due_date)) {
      return res.status(400).json({ error: 'Owner is not on freeze for this date' });
    }
    const result = db.prepare(`
      UPDATE assignments
      SET person_id = ?, status = 'pending', note = '', stolen_from = NULL,
          updated_at = datetime('now')
      WHERE id = ? AND status = 'excused'
    `).run(claimerId, req.params.id);
    if (result.changes === 0) {
      return res.status(409).json({ error: 'Already claimed' });
    }
    res.json({ ok: true });
    notifyWall();
  });
```

`requireRole`, `isOnFreeze`, and `notifyWall` are already imported at the top of the file from prior phases — verify by reading the imports before adding code. If any is missing, add to the existing import line.

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && node --test tests/routes-claim-cover.test.js && npm test 2>&1 | grep -E "# (tests|pass|fail)"
```

Expected: claim-cover tests pass; full suite 204 (196 prior + 8 new), 0 fail.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/routes/home.js tests/routes-claim-cover.test.js && git commit -m "feat(home): POST /assignments/:id/claim-cover for siblings of frozen kids"
```

---

## Task 3: Kid home UI — "Cover for a sibling" section

**Files:**
- Modify: `public/js/pages/home.js`

- [ ] **Step 1: Add the covers section in `renderHome`**

Read the file to find the existing `stealSection` block (around line 92). The section is a `(data.stealable && data.stealable.length > 0) ? el(...) : null` ternary. Add a new `coversSection` declared similarly, immediately ABOVE the `stealSection` declaration (so it ends up rendered above it):

```js
  const coversSection = (data.covers && data.covers.length > 0)
    ? el('section', { class: 'stack' }, [
        el('div', { class: 'label' }, ['Cover for a sibling']),
        ...data.covers.map(s => el('div', { class: 'txn steal-row' }, [
          el('div', { class: 'left' }, [
            el('div', { class: 'chip', style: { background: s.owner_color || '#0F172A' } }, [s.owner_name[0]]),
            el('div', {}, [
              el('div', {}, [s.title]),
              el('div', { class: 'muted', style: { fontSize: '0.7rem' } }, [`for ${s.owner_name}`]),
            ]),
          ]),
          el('button', {
            class: 'btn btn-primary btn-done',
            onClick: async (e) => {
              e.stopPropagation();
              e.target.disabled = true;
              e.target.textContent = '…';
              try {
                await api.post(`/api/assignments/${s.id}/claim-cover`);
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
          }, [`Claim · +${s.display_points}`]),
        ])),
      ])
    : null;
```

- [ ] **Step 2: Place it in the page layout**

Find the page layout assembly (the final `root.appendChild(el('div', { class: 'page stack' }, [...]))` block). The children list currently ends with `bonusBoardSection, stealSection, el('div', ...sign-out)`. Change to insert `coversSection` directly before `stealSection`:

```js
    bonusBoardSection,
    coversSection,
    stealSection,
```

- [ ] **Step 3: Syntax check + tests**

```bash
cd ~/projects/tally && node --check public/js/pages/home.js && npm test 2>&1 | grep -E "# (tests|pass|fail)"
```

Expected: parses cleanly; full suite 204 pass, 0 fail (no new server tests, client-only change).

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/home.js && git commit -m "feat(home): render Cover for a sibling section above steal section"
```

---

## Task 4: Deploy + tag

- [ ] **Step 1: Final suite**

```bash
cd ~/projects/tally && npm test 2>&1 | grep -E "# (tests|pass|fail)"
```

Expected: 204 pass, 0 fail.

- [ ] **Step 2: Reload PM2 + verify health**

```bash
cd ~/projects/tally && pm2 reload tally 2>&1 | tail -1 && sleep 2 && curl -sf http://localhost:3012/api/health && echo " <- health"
```

Expected: `{"ok":true}`.

- [ ] **Step 3: Tag and push**

```bash
cd ~/projects/tally && git tag v0.10.2-cover-frozen-sibling && git push origin master && git push origin v0.10.2-cover-frozen-sibling 2>&1 | tail -3
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task(s) |
|---|---|
| §4 Data flow (excused + owner-frozen + sibling) | Task 1 (filter in `covers`), Task 2 (endpoint validation) |
| §5 Modified GET /api/home `covers` array | Task 1 |
| §5 POST /api/assignments/:id/claim-cover | Task 2 |
| §6 Kid home UI section placement above steal | Task 3 |
| §7 Tests (home covers payload + claim-cover endpoint) | Tasks 1, 2 |
| §8 Tech notes (isOnFreeze reuse, no stolen_from, race safety) | Task 2 (WHERE status='excused' guard + result.changes==0) |
| §9 Acceptance | Task 4 + manual |

**Placeholder scan:** Every step has concrete code or commands. No TBDs.

**Type consistency:**
- `covers` payload shape (`id`, `title`, `weight`, `anti_cheat`, `owner_id`, `owner_name`, `owner_color`, `display_points`) consistent between Task 1 (route) and Task 3 (UI consumer).
- `POST /api/assignments/:id/claim-cover` path identical in Task 2 (definition), Task 2 tests, and Task 3 (UI caller).
- Status transitions consistent: assignment starts `'excused'`, validation requires `'excused'`, UPDATE guards `WHERE status = 'excused'`, ends as `'pending'`.
- `notifyWall()` import already present in home.js from prior phases — verified by Task 2's "verify by reading imports" note.

Plan is internally consistent.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-29-tally-cover-for-frozen-sibling.md`. 4 tasks. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, verification between
**2. Inline** — direct in this session

Which approach?
