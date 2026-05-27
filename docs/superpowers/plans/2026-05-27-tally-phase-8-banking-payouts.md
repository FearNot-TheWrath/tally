# Tally — Phase 8 Banking & Payouts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-deposit weekly earnings into a per-kid bank balance, with a transaction ledger, manual parent adjustments, and kid-visible balance + history.

**Architecture:** New `transactions` table (migration 006). New `src/lib/payout.js` module with `runPayoutIfDue(db)` called lazily on `/api/home` and `/api/wall`. New `src/routes/admin/bank.js` for parent adjustment endpoint. Frontend: kid home shows balance + transaction list, wall shows balance per kid, admin gets a Bank tab.

**Tech Stack:** Same as prior phases. Node 20+, Express 5, better-sqlite3, vanilla JS SPA. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-05-27-tally-phase-8-banking-payouts.md`](../specs/2026-05-27-tally-phase-8-banking-payouts.md)

---

## File Structure

```
~/projects/tally/
├── src/
│   ├── migrations/
│   │   └── 006-transactions.sql                     NEW
│   ├── lib/
│   │   └── payout.js                                NEW: runPayoutIfDue
│   └── routes/
│       ├── home.js                                  MODIFY: add runPayoutIfDue + bank_cents + transactions
│       ├── wall.js                                  MODIFY: add runPayoutIfDue + bank_cents per kid
│       └── admin/
│           ├── bank.js                              NEW: GET /bank + POST /bank/:id/adjust
│           └── today.js                             MODIFY: add bank_cents per kid
├── public/
│   ├── js/pages/
│   │   ├── admin.js                                 MODIFY: Bank tab + payout settings
│   │   ├── home.js                                  MODIFY: bank section
│   │   └── wall.js                                  MODIFY: balance in meta line
│   └── css/layouts.css                              MODIFY: bank section styles
├── tests/
│   ├── lib-payout.test.js                           NEW
│   └── routes-admin-bank.test.js                    NEW
└── src/app.js                                       MODIFY: mount bank routes
```

---

## Task 1: Migration 006 — transactions table

**Files:**
- Create: `src/migrations/006-transactions.sql`

- [ ] **Step 1: Create migration**

```sql
CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id   INTEGER NOT NULL REFERENCES people(id),
  type        TEXT NOT NULL CHECK(type IN ('deposit','withdrawal','adjustment')),
  amount_cents INTEGER NOT NULL,
  note        TEXT,
  week_start  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_transactions_person ON transactions(person_id, created_at DESC);
CREATE INDEX idx_transactions_deposit ON transactions(person_id, type, week_start);
```

- [ ] **Step 2: Verify migration runs**

```bash
cd ~/projects/tally && node -e "import('./src/db.js').then(m => { const db = m.openDb(':memory:'); console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='transactions'\").get()); })"
```

Expected: `{ name: 'transactions' }`

- [ ] **Step 3: Run existing tests (migration should not break anything)**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 144 tests.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add src/migrations/006-transactions.sql && git commit -m "feat(schema): migration 006 transactions table"
```

---

## Task 2: `src/lib/payout.js` — auto-deposit logic + tests

**Files:**
- Create: `src/lib/payout.js`
- Create: `tests/lib-payout.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/lib-payout.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { runPayoutIfDue, _resetCache } from '../src/lib/payout.js';
import { today, toIso, weekStart } from '../src/lib/dates.js';

function seedKid(db, name = 'K', target = 100, basePay = 1000, bonusRate = 10) {
  return db.prepare(
    "INSERT INTO people (name, role, weekly_target_pts, base_pay_cents, bonus_rate_cents) VALUES (?, 'kid', ?, ?, ?) RETURNING id"
  ).get(name, target, basePay, bonusRate).id;
}
function seedChore(db, weight = 3) {
  return db.prepare(
    "INSERT INTO chores (title, weight, recurs, default_assignees) VALUES ('T', ?, 'daily', '') RETURNING id"
  ).get(weight).id;
}
function seedDoneAssignment(db, choreId, kidId, dueDate) {
  db.prepare(
    "INSERT INTO assignments (chore_id, person_id, due_date, status) VALUES (?, ?, ?, 'done')"
  ).run(choreId, kidId, dueDate);
}
function setPayoutSettings(db, day, time) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('payout_day', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(day);
  db.prepare("INSERT INTO settings (key, value) VALUES ('payout_time', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(time);
}
function getDeposits(db, kidId) {
  return db.prepare("SELECT * FROM transactions WHERE person_id = ? AND type = 'deposit' ORDER BY created_at").all(kidId);
}
function dayName(d) {
  return ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][d.getDay()];
}

test('runPayoutIfDue does nothing before payout boundary', () => {
  _resetCache();
  const db = freshDb();
  const kid = seedKid(db);
  // Set payout to tomorrow
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  setPayoutSettings(db, dayName(tomorrow), '00:00');
  runPayoutIfDue(db);
  const deposits = getDeposits(db, kid);
  assert.equal(deposits.length, 0);
});

test('runPayoutIfDue deposits for all kids when past boundary', () => {
  _resetCache();
  const db = freshDb();
  const kid1 = seedKid(db, 'A');
  const kid2 = seedKid(db, 'B');
  const c = seedChore(db);
  // Seed done assignments for last week
  const lastMonday = new Date();
  const dow = lastMonday.getDay();
  lastMonday.setDate(lastMonday.getDate() - (dow === 0 ? 6 : dow - 1) - 7);
  for (let i = 0; i < 7; i++) {
    const d = new Date(lastMonday);
    d.setDate(d.getDate() + i);
    const iso = toIso(d);
    seedDoneAssignment(db, c, kid1, iso);
    seedDoneAssignment(db, c, kid2, iso);
  }
  // Set payout to yesterday at midnight so we're past the boundary
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  setPayoutSettings(db, dayName(yesterday), '00:00');
  runPayoutIfDue(db);
  assert.ok(getDeposits(db, kid1).length >= 1);
  assert.ok(getDeposits(db, kid2).length >= 1);
});

test('double-deposit prevention: calling twice creates only one deposit per kid', () => {
  _resetCache();
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  const lastMonday = new Date();
  const dow = lastMonday.getDay();
  lastMonday.setDate(lastMonday.getDate() - (dow === 0 ? 6 : dow - 1) - 7);
  seedDoneAssignment(db, c, kid, toIso(lastMonday));
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  setPayoutSettings(db, dayName(yesterday), '00:00');
  runPayoutIfDue(db);
  _resetCache();
  runPayoutIfDue(db);
  const deposits = getDeposits(db, kid);
  const ws = weekStart(toIso(lastMonday));
  const forWeek = deposits.filter(d => d.week_start === ws);
  assert.equal(forWeek.length, 1);
});

test('bank_cents reflects deposited amount', () => {
  _resetCache();
  const db = freshDb();
  const kid = seedKid(db, 'K', 100, 1000, 0);
  const c = seedChore(db);
  const lastMonday = new Date();
  const dow = lastMonday.getDay();
  lastMonday.setDate(lastMonday.getDate() - (dow === 0 ? 6 : dow - 1) - 7);
  for (let i = 0; i < 7; i++) {
    const d = new Date(lastMonday);
    d.setDate(d.getDate() + i);
    seedDoneAssignment(db, c, kid, toIso(d));
  }
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  setPayoutSettings(db, dayName(yesterday), '00:00');
  runPayoutIfDue(db);
  const person = db.prepare('SELECT bank_cents FROM people WHERE id = ?').get(kid);
  assert.ok(person.bank_cents > 0);
  const deposit = getDeposits(db, kid)[0];
  assert.equal(person.bank_cents, deposit.amount_cents);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL — `src/lib/payout.js` doesn't exist.

- [ ] **Step 3: Create `src/lib/payout.js`**

```js
import { today, toIso, fromIso, weekStart } from './dates.js';
import { calcWeekPoints, calcProjectedPay } from './points.js';

const DAY_MAP = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

let lastPayoutCheck = 0;

export function _resetCache() {
  lastPayoutCheck = 0;
}

export function runPayoutIfDue(db) {
  const now = Date.now();
  if (now - lastPayoutCheck < 60_000) return;
  lastPayoutCheck = now;

  const dayRow = db.prepare("SELECT value FROM settings WHERE key = 'payout_day'").get();
  const timeRow = db.prepare("SELECT value FROM settings WHERE key = 'payout_time'").get();
  const payoutDay = DAY_MAP[dayRow?.value || 'sunday'];
  const payoutTime = timeRow?.value || '20:00';

  const boundary = mostRecentBoundary(payoutDay, payoutTime);
  if (!boundary) return;

  const boundaryWeekStart = weekStartFromBoundary(boundary);

  const kids = db.prepare("SELECT * FROM people WHERE role = 'kid'").all();
  if (kids.length === 0) return;

  for (let weeksBack = 8; weeksBack >= 0; weeksBack--) {
    const d = fromIso(boundaryWeekStart);
    d.setDate(d.getDate() - weeksBack * 7);
    const ws = toIso(d);

    const alreadyPaid = db.prepare(
      "SELECT 1 FROM transactions WHERE type = 'deposit' AND week_start = ? LIMIT 1"
    ).get(ws);
    if (alreadyPaid) continue;

    const deposit = db.transaction(() => {
      for (const kid of kids) {
        const existing = db.prepare(
          "SELECT 1 FROM transactions WHERE person_id = ? AND type = 'deposit' AND week_start = ?"
        ).get(kid.id, ws);
        if (existing) continue;

        const pts = calcWeekPoints(db, kid.id, ws);
        const earned = calcProjectedPay(kid, pts.points);

        db.prepare(
          "INSERT INTO transactions (person_id, type, amount_cents, note, week_start) VALUES (?, 'deposit', ?, ?, ?)"
        ).run(kid.id, earned, `Week of ${ws}`, ws);

        if (earned > 0) {
          db.prepare("UPDATE people SET bank_cents = bank_cents + ? WHERE id = ?").run(earned, kid.id);
        }
      }
    });
    deposit();
  }
}

function mostRecentBoundary(payoutDayNum, payoutTime) {
  const now = new Date();
  const [hh, mm] = payoutTime.split(':').map(Number);
  const d = new Date(now);

  for (let i = 0; i < 8; i++) {
    if (d.getDay() === payoutDayNum) {
      const cutoff = new Date(d);
      cutoff.setHours(hh, mm, 0, 0);
      if (i === 0 && now < cutoff) {
        d.setDate(d.getDate() - 1);
        continue;
      }
      return toIso(d);
    }
    d.setDate(d.getDate() - 1);
  }
  return null;
}

function weekStartFromBoundary(boundaryIso) {
  const d = fromIso(boundaryIso);
  const dow = d.getDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + offset);
  return toIso(d);
}
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 148 tests (144 prior + 4 new).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/lib/payout.js tests/lib-payout.test.js && git commit -m "feat(lib/payout): runPayoutIfDue auto-deposit with double-deposit prevention"
```

---

## Task 3: Admin bank routes + tests

**Files:**
- Create: `src/routes/admin/bank.js`
- Create: `tests/routes-admin-bank.test.js`
- Modify: `src/app.js`

- [ ] **Step 1: Write failing tests**

Create `tests/routes-admin-bank.test.js`:

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

test('GET /api/admin/bank returns kids with bank_cents and transactions', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role, bank_cents) VALUES ('K','kid', 500) RETURNING id").get().id;
  db.prepare("INSERT INTO transactions (person_id, type, amount_cents, note) VALUES (?, 'deposit', 500, 'Test')").run(kid);
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.get('/api/admin/bank');
  assert.equal(res.status, 200);
  assert.equal(res.body.kids.length, 1);
  assert.equal(res.body.kids[0].bank_cents, 500);
  assert.equal(res.body.kids[0].transactions.length, 1);
  assert.equal(res.body.kids[0].transactions[0].amount_cents, 500);
});

test('POST /api/admin/bank/:id/adjust adds to balance with positive amount', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role, bank_cents) VALUES ('K','kid', 1000) RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.post(`/api/admin/bank/${kid}/adjust`).send({ amount_cents: 500, note: 'Birthday gift' });
  assert.equal(res.status, 200);
  assert.equal(res.body.bank_cents, 1500);
  assert.equal(res.body.transaction.amount_cents, 500);
  assert.equal(res.body.transaction.note, 'Birthday gift');
});

test('POST /api/admin/bank/:id/adjust deducts with negative amount', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role, bank_cents) VALUES ('K','kid', 1000) RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.post(`/api/admin/bank/${kid}/adjust`).send({ amount_cents: -300, note: 'Bought a book' });
  assert.equal(res.status, 200);
  assert.equal(res.body.bank_cents, 700);
  assert.equal(res.body.transaction.amount_cents, -300);
});

test('POST /api/admin/bank/:id/adjust requires note', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.post(`/api/admin/bank/${kid}/adjust`).send({ amount_cents: 100, note: '' });
  assert.equal(res.status, 400);
});

test('POST /api/admin/bank/:id/adjust rejects zero amount', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.post(`/api/admin/bank/${kid}/adjust`).send({ amount_cents: 0, note: 'Nothing' });
  assert.equal(res.status, 400);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL — route doesn't exist (404).

- [ ] **Step 3: Create `src/routes/admin/bank.js`**

```js
import { Router } from 'express';
import { requireRole } from '../../auth.js';
import { notifyWall } from '../../lib/events.js';

export function adminBankRoutes() {
  const r = Router();
  r.use(requireRole('parent'));

  r.get('/bank', (req, res) => {
    const db = req.app.get('db');
    const kids = db.prepare(
      "SELECT id, name, avatar_color, bank_cents FROM people WHERE role = 'kid' ORDER BY name"
    ).all();
    for (const kid of kids) {
      kid.transactions = db.prepare(
        "SELECT id, type, amount_cents, note, week_start, created_at FROM transactions WHERE person_id = ? ORDER BY created_at DESC LIMIT 20"
      ).all(kid.id);
    }
    res.json({ kids });
  });

  r.post('/bank/:personId/adjust', (req, res) => {
    const db = req.app.get('db');
    const personId = parseInt(req.params.personId, 10);
    const { amount_cents, note } = req.body || {};

    if (!Number.isFinite(amount_cents) || amount_cents === 0) {
      return res.status(400).json({ error: 'amount_cents must be a nonzero number' });
    }
    if (!note || !String(note).trim()) {
      return res.status(400).json({ error: 'note is required' });
    }

    const person = db.prepare("SELECT id, bank_cents FROM people WHERE id = ? AND role = 'kid'").get(personId);
    if (!person) return res.status(404).json({ error: 'Kid not found' });

    const txn = db.transaction(() => {
      const row = db.prepare(
        "INSERT INTO transactions (person_id, type, amount_cents, note) VALUES (?, 'adjustment', ?, ?) RETURNING *"
      ).get(personId, amount_cents, String(note).trim());
      db.prepare("UPDATE people SET bank_cents = bank_cents + ? WHERE id = ?").run(amount_cents, personId);
      const updated = db.prepare("SELECT bank_cents FROM people WHERE id = ?").get(personId);
      return { transaction: row, bank_cents: updated.bank_cents };
    });

    const result = txn();
    res.json({ ok: true, bank_cents: result.bank_cents, transaction: result.transaction });
    notifyWall();
  });

  return r;
}
```

- [ ] **Step 4: Mount in `src/app.js`**

Add import at top (after the existing admin imports):

```js
import { adminBankRoutes } from './routes/admin/bank.js';
```

Add route mount (after `adminBonusesRoutes`):

```js
  app.use('/api/admin', adminBankRoutes());
```

- [ ] **Step 5: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 153 tests (148 prior + 5 new).

- [ ] **Step 6: Commit**

```bash
cd ~/projects/tally && git add src/routes/admin/bank.js tests/routes-admin-bank.test.js src/app.js && git commit -m "feat(admin/bank): GET /bank + POST /bank/:id/adjust endpoints"
```

---

## Task 4: Wire `runPayoutIfDue` + `bank_cents` + `transactions` into `/api/home`

**Files:**
- Modify: `src/routes/home.js`

- [ ] **Step 1: Modify `src/routes/home.js`**

Add import at top:

```js
import { runPayoutIfDue } from '../lib/payout.js';
```

Inside the `r.get('/home', ...)` handler, add `runPayoutIfDue(db);` right after `const db = req.app.get('db');` and before the person query.

After the existing `person.on_freeze = isOnFreeze(db, personId);` line, add:

```js
    person.transactions = db.prepare(
      "SELECT id, type, amount_cents, note, created_at FROM transactions WHERE person_id = ? ORDER BY created_at DESC LIMIT 10"
    ).all(personId);
```

Note: `bank_cents` is already selected in the person query (line 21-24 already includes `bank_cents`), so it's already in the response. Just need to add `transactions`.

- [ ] **Step 2: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 153 tests.

- [ ] **Step 3: Commit**

```bash
cd ~/projects/tally && git add src/routes/home.js && git commit -m "feat(home): runPayoutIfDue + transactions in /api/home response"
```

---

## Task 5: Wire `runPayoutIfDue` + `bank_cents` into `/api/wall` and `/api/admin/today`

**Files:**
- Modify: `src/routes/wall.js`
- Modify: `src/routes/admin/today.js`

- [ ] **Step 1: Modify `src/routes/wall.js`**

Add import:

```js
import { runPayoutIfDue } from '../lib/payout.js';
```

Inside `r.get('/wall', ...)`, add `runPayoutIfDue(db);` right after `const db = req.app.get('db');`.

The kid query already selects `bank_cents` (line 12 of wall.js: `SELECT id, name, avatar_color, weekly_target_pts, streak_days`). Add `bank_cents` to that SELECT:

Change:
```sql
SELECT id, name, avatar_color, weekly_target_pts, streak_days
FROM people WHERE role = 'kid' ORDER BY id
```
To:
```sql
SELECT id, name, avatar_color, weekly_target_pts, streak_days, bank_cents
FROM people WHERE role = 'kid' ORDER BY id
```

- [ ] **Step 2: Modify `src/routes/admin/today.js`**

Add import:

```js
import { runPayoutIfDue } from '../../lib/payout.js';
```

Inside `r.get('/today', ...)`, add `runPayoutIfDue(db);` after `const db = req.app.get('db');`.

Change the kid query to include `bank_cents`:

```sql
SELECT id, name, avatar_color, weekly_target_pts, base_pay_cents, bonus_rate_cents, bank_cents
FROM people WHERE role = 'kid' ORDER BY name
```

- [ ] **Step 3: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 153 tests.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add src/routes/wall.js src/routes/admin/today.js && git commit -m "feat(wall+admin): runPayoutIfDue + bank_cents in wall and today responses"
```

---

## Task 6: Kid home UI — bank section

**Files:**
- Modify: `public/js/pages/home.js`
- Modify: `public/css/layouts.css`

- [ ] **Step 1: Add bank section to `renderHome`**

In `public/js/pages/home.js`, find the block that builds the page layout:

```js
  root.appendChild(el('div', { class: 'page stack' }, [
    el('header', { class: 'app-header' }, [ ... ]),
    hero,
    todaySection,
```

Add a `bankSection` between `hero` and `todaySection`. Build it just before `todaySection`:

```js
  const bankDollars = ((p.bank_cents || 0) / 100).toFixed(2);
  const bankSection = el('section', { class: 'stack' }, [
    el('div', { class: 'label' }, ['Bank']),
    el('div', { class: 'bank-balance', style: { color: p.bank_cents >= 0 ? 'var(--green)' : 'var(--red)' } }, [`$${bankDollars}`]),
    ...(p.transactions && p.transactions.length > 0
      ? p.transactions.map(t => {
          const d = t.created_at ? t.created_at.slice(5, 10).replace('-', '/') : '';
          const amt = (t.amount_cents / 100).toFixed(2);
          const prefix = t.amount_cents >= 0 ? '+' : '';
          return el('div', { class: 'bank-txn' }, [
            el('span', { class: 'bank-txn-date' }, [d]),
            el('span', { class: 'bank-txn-note' }, [t.note || '']),
            el('span', {
              class: 'bank-txn-amt',
              style: { color: t.amount_cents >= 0 ? 'var(--green)' : 'var(--red)' },
            }, [`${prefix}$${Math.abs(t.amount_cents / 100).toFixed(2)}`]),
          ]);
        })
      : [el('p', { class: 'muted', style: { fontSize: '0.82rem' } }, ['No transactions yet.'])]
    ),
  ]);
```

Then in the page layout, insert it:

```js
  root.appendChild(el('div', { class: 'page stack' }, [
    el('header', ...),
    hero,
    bankSection,
    todaySection,
    ...
  ].filter(Boolean)));
```

- [ ] **Step 2: Add CSS styles**

Append to `public/css/layouts.css`:

```css
.bank-balance {
  font-family: var(--font-num);
  font-size: 2rem;
  font-weight: 700;
  letter-spacing: -1px;
}
.bank-txn {
  display: grid;
  grid-template-columns: 50px 1fr auto;
  gap: 8px;
  align-items: center;
  padding: 6px 0;
  font-size: 0.85rem;
  border-bottom: 1px solid var(--border);
}
.bank-txn-date {
  font-family: var(--font-num);
  color: var(--muted);
  font-size: 0.78rem;
}
.bank-txn-note {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bank-txn-amt {
  font-family: var(--font-num);
  font-weight: 600;
  white-space: nowrap;
}
```

- [ ] **Step 3: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 153 tests.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/home.js public/css/layouts.css && git commit -m "feat(home): bank balance + transaction history section"
```

---

## Task 7: Wall UI — balance in meta line

**Files:**
- Modify: `public/js/pages/wall.js`

- [ ] **Step 1: Modify wall meta line**

In `public/js/pages/wall.js`, find the per-kid meta line:

```js
        el('div', { class: 'meta' }, [
          el('span', {}, [`${k.points || 0} pts (${Math.round((k.percent || 0) * 100)}%)`]),
          el('span', {}, [`${k.streak_days || 0}d streak`]),
        ]),
```

Change to:

```js
        el('div', { class: 'meta' }, [
          el('span', { style: { color: 'var(--green)' } }, [`$${((k.bank_cents || 0) / 100).toFixed(2)}`]),
          el('span', {}, [`${k.points || 0} pts (${Math.round((k.percent || 0) * 100)}%)`]),
          el('span', {}, [`${k.streak_days || 0}d streak`]),
        ]),
```

- [ ] **Step 2: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 153 tests.

- [ ] **Step 3: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/wall.js && git commit -m "feat(wall): show kid bank balance in column meta"
```

---

## Task 8: Admin UI — Bank tab

**Files:**
- Modify: `public/js/pages/admin.js`

- [ ] **Step 1: Add Bank tab to TABS array**

In `public/js/pages/admin.js`, find the TABS array. Add a Bank entry after 'bonuses':

```js
const TABS = [
  { key: 'today',      label: 'Today',      render: renderToday },
  { key: 'day-review', label: 'Day review', render: renderDayReview },
  { key: 'approvals',  label: 'Approvals',  render: renderApprovals },
  { key: 'bonuses',    label: 'Bonus board', render: renderBonuses },
  { key: 'bank',       label: 'Bank',       render: renderBank },
  { key: 'people',     label: 'People',     render: renderPeople },
  { key: 'chores',     label: 'Chores',     render: renderChores },
  { key: 'settings',   label: 'Settings',   render: renderSettings },
];
```

- [ ] **Step 2: Add `renderBank` function**

Add before the `/* ───── Bonus Board tab ───── */` comment:

```js
/* ───── Bank tab ───── */
async function renderBank(host) {
  clear(host);
  const { kids } = await api.get('/api/admin/bank');

  host.appendChild(el('h3', { style: { marginBottom: 'var(--s4)' } }, ['Bank']));

  for (const kid of kids) {
    const dollars = ((kid.bank_cents || 0) / 100).toFixed(2);
    const card = el('div', { class: 'card', style: { marginBottom: 'var(--s4)' } }, [
      el('div', { class: 'row spaced', style: { marginBottom: 'var(--s3)' } }, [
        el('div', { class: 'row' }, [
          el('div', { class: 'av', style: { background: kid.avatar_color } }, [kid.name[0]]),
          el('div', {}, [
            el('div', { style: { fontWeight: 600 } }, [kid.name]),
            el('div', { style: { fontFamily: 'var(--font-num)', fontSize: '1.4rem', fontWeight: 700, color: 'var(--green)' } }, [`$${dollars}`]),
          ]),
        ]),
        el('button', { class: 'btn btn-primary', onClick: () => adjustModal(kid, host) }, ['Adjust']),
      ]),
      ...(kid.transactions.length > 0
        ? kid.transactions.map(t => {
            const d = t.created_at ? t.created_at.slice(0, 10) : '';
            const amt = (Math.abs(t.amount_cents) / 100).toFixed(2);
            const prefix = t.amount_cents >= 0 ? '+' : '-';
            const color = t.amount_cents >= 0 ? 'var(--green)' : 'var(--red)';
            return el('div', { class: 'bank-txn' }, [
              el('span', { class: 'bank-txn-date' }, [d]),
              el('span', { class: 'bank-txn-note' }, [t.note || '']),
              el('span', { class: 'bank-txn-amt', style: { color } }, [`${prefix}$${amt}`]),
            ]);
          })
        : [el('p', { class: 'muted', style: { fontSize: '0.82rem' } }, ['No transactions yet.'])]
      ),
    ]);
    host.appendChild(card);
  }
}

function adjustModal(kid, host) {
  let amountVal = '';
  let noteVal = '';

  const modal = el('div', { class: 'modal-backdrop', onClick: e => { if (e.target === modal) modal.remove(); } }, [
    el('div', { class: 'modal' }, [
      el('h3', { style: { marginBottom: 'var(--s3)' } }, [`Adjust ${kid.name}'s balance`]),
      el('div', { class: 'form-field' }, [
        el('label', {}, ['Amount ($)']),
        el('input', { type: 'number', step: '0.01', min: '0', placeholder: '5.00', onInput: e => amountVal = e.target.value }),
      ]),
      el('div', { class: 'form-field' }, [
        el('label', {}, ['Note (required)']),
        el('input', { type: 'text', placeholder: 'Bought a book', onInput: e => noteVal = e.target.value }),
      ]),
      el('div', { class: 'row spaced', style: { marginTop: 'var(--s4)' } }, [
        el('button', { class: 'btn btn-ghost', onClick: () => modal.remove() }, ['Cancel']),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn btn-danger', onClick: async () => {
            const cents = Math.round(parseFloat(amountVal) * 100);
            if (!cents || !noteVal.trim()) { alert('Amount and note required'); return; }
            try {
              await api.post(`/api/admin/bank/${kid.id}/adjust`, { amount_cents: -cents, note: noteVal.trim() });
              modal.remove();
              renderBank(host);
            } catch (e) { alert(e.message); }
          }}, ['Deduct']),
          el('button', { class: 'btn btn-primary', onClick: async () => {
            const cents = Math.round(parseFloat(amountVal) * 100);
            if (!cents || !noteVal.trim()) { alert('Amount and note required'); return; }
            try {
              await api.post(`/api/admin/bank/${kid.id}/adjust`, { amount_cents: cents, note: noteVal.trim() });
              modal.remove();
              renderBank(host);
            } catch (e) { alert(e.message); }
          }}, ['Add']),
        ]),
      ]),
    ]),
  ]);
  document.body.appendChild(modal);
}
```

- [ ] **Step 3: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 153 tests.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/admin.js && git commit -m "feat(admin): Bank tab with per-kid balance, transactions, and adjust modal"
```

---

## Task 9: Admin Settings — payout day + time inputs

**Files:**
- Modify: `public/js/pages/admin.js`

- [ ] **Step 1: Add payout settings to `renderSettings`**

In the `renderSettings` function, after the `streak_warning_time` field, add:

```js
  const dayField = el('div', { class: 'form-field' }, [
    el('label', {}, ['Payout day']),
    el('select', {
      onChange: async (e) => {
        try {
          await api.patch('/api/admin/settings/payout_day', { value: e.target.value });
          e.target.style.borderColor = 'var(--green)';
          setTimeout(() => { e.target.style.borderColor = ''; }, 800);
        } catch (err) { alert('Save failed: ' + err.message); }
      },
    }, ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].map(d =>
      el('option', { value: d, selected: (s.payout_day || 'sunday') === d }, [d.charAt(0).toUpperCase() + d.slice(1)])
    )),
    el('div', { class: 'muted', style: { fontSize: '0.78rem', marginTop: '4px' } }, [
      'Day of week when weekly earnings are deposited into kid balances.',
    ]),
  ]);

  host.appendChild(dayField);
  host.appendChild(timeField(
    'payout_time', '20:00',
    'Payout time (24-hour local)',
    'Time on payout day when the deposit happens (on next app visit after this time).',
  ));
```

- [ ] **Step 2: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 153 tests.

- [ ] **Step 3: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/admin.js && git commit -m "feat(admin/settings): payout day dropdown + payout time input"
```

---

## Task 10: Deploy + tag v0.8.0-phase8

- [ ] **Step 1: Final test run**

```bash
cd ~/projects/tally && npm test
```

Expected: 153 tests pass.

- [ ] **Step 2: Reload PM2 + verify**

```bash
cd ~/projects/tally && pm2 reload tally
sleep 3
curl -sf http://localhost:3012/api/health
```

Expected: `{"ok":true}`.

- [ ] **Step 3: Verify bank fields in API**

```bash
curl -sf http://localhost:3012/api/wall | python3 -c "import sys,json; d=json.load(sys.stdin); print('bank_cents on kids:', all('bank_cents' in k for k in d['kids']))"
```

Expected: `True`.

- [ ] **Step 4: Tag the release**

```bash
cd ~/projects/tally && git tag v0.8.0-phase8 && git log --oneline -12 && git tag -l 'v*'
```

---

## Self-Review

**Spec coverage:**

| Spec section | Covered by Task(s) |
|---|---|
| §1 Summary | All tasks |
| §2 Goals (balance, auto-deposit, ledger, adjustments, kid visibility, catchup) | Tasks 2-8 |
| §3 Non-goals | Honored (no real money, no kid withdrawals, no savings goals) |
| §4 Schema | Task 1 |
| §5 Auto-deposit logic | Task 2 |
| §6 API surface: home | Task 4 |
| §6 API surface: wall | Task 5 |
| §6 API surface: admin/today | Task 5 |
| §6 API surface: admin/bank | Task 3 |
| §6 Settings (payout_day, payout_time) | Task 9 |
| §7 UI: kid home bank section | Task 6 |
| §7 UI: admin Bank tab | Task 8 |
| §7 UI: admin Settings payout inputs | Task 9 |
| §7 UI: wall balance | Task 7 |
| §8 Tests | Tasks 2, 3 |
| §9 Tech notes | Implementation in Tasks 2-5 |
| §10 Acceptance test | Task 10 |

**Placeholder scan:** Every step has complete code. No TBDs.

**Type consistency:**
- `runPayoutIfDue(db)` signature consistent in Tasks 2, 4, 5
- `bank_cents` field name consistent across people table, API responses, and UI
- `amount_cents` in adjust endpoint consistent between test (Task 3) and route (Task 3)
- `transactions` array shape consistent between bank.js (Task 3), home.js (Task 4), and UI (Tasks 6, 8)
- `notifyWall()` called in adjust endpoint (Task 3), consistent with Phase 5 pattern
- `_resetCache()` exported for test isolation (Task 2)

Plan is internally consistent.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-27-tally-phase-8-banking-payouts.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks

**2. Inline Execution** — I execute directly in this session (has been working well for the last 3 phases)

Which approach?
