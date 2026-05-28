# Tally — Phase 7 Web Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send opt-in browser push notifications to kids for streak-at-risk (time-based), payday deposits, and new bonuses.

**Architecture:** `web-push` library handles VAPID + encryption. A `push_subscriptions` table stores each device. `src/lib/push.js` wraps sending. Event triggers (bonus, payday) call it inline; a once-a-minute `setInterval` scheduler (`src/lib/scheduler.js`) handles the streak reminder. All push paths no-op when VAPID keys are absent, so tests and dev clones run unchanged.

**Tech Stack:** Node 20+, Express 5, better-sqlite3, `web-push` (new dep), service worker, browser Push API.

**Spec:** [`docs/superpowers/specs/2026-05-27-tally-phase-7-web-push.md`](../specs/2026-05-27-tally-phase-7-web-push.md)

---

## File Structure

```
~/projects/tally/
├── package.json                                    MODIFY: add web-push
├── server.js                                       MODIFY: startScheduler(db)
├── src/
│   ├── migrations/
│   │   └── 008-push-subscriptions.sql              NEW
│   ├── lib/
│   │   ├── push.js                                 NEW: isPushConfigured, getPublicKey, saveSubscription, removeSubscription, sendToPerson
│   │   ├── scheduler.js                            NEW: streakReminderDue, startScheduler
│   │   └── payout.js                               MODIFY: notify on deposit
│   └── routes/
│       ├── push.js                                 NEW: vapid-key, subscribe, unsubscribe
│       └── admin/bonuses.js                        MODIFY: notify kids on new bonus
├── public/
│   ├── sw.js                                       MODIFY: push + notificationclick handlers
│   └── js/
│       ├── lib/push-client.js                      NEW: enablePush, pushStatus
│       └── pages/home.js                           MODIFY: "Turn on reminders" button
├── src/app.js                                      MODIFY: mount push routes
└── tests/
    ├── lib-push.test.js                            NEW
    ├── routes-push.test.js                         NEW
    └── lib-scheduler.test.js                       NEW
```

---

## Task 1: Migration 007 + add web-push dependency

**Files:**
- Create: `src/migrations/008-push-subscriptions.sql`
- Modify: `package.json` (via npm install)

- [ ] **Step 1: Create migration**

```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id   INTEGER NOT NULL REFERENCES people(id),
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_push_person ON push_subscriptions(person_id);
```

- [ ] **Step 2: Install web-push**

```bash
cd ~/projects/tally && npm install web-push
```

Expected: `web-push` added to dependencies in package.json.

- [ ] **Step 3: Verify migration + dependency**

```bash
cd ~/projects/tally && node -e "import('./src/db.js').then(m => { const db = m.openDb(':memory:'); console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='push_subscriptions'\").get()); })" && node -e "import('web-push').then(() => console.log('web-push ok'))"
```

Expected: `{ name: 'push_subscriptions' }` and `web-push ok`.

- [ ] **Step 4: Run existing tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 153 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/migrations/008-push-subscriptions.sql package.json package-lock.json && git commit -m "feat(schema): migration 008 push_subscriptions + web-push dep"
```

---

## Task 2: `src/lib/push.js` + tests

**Files:**
- Create: `src/lib/push.js`
- Create: `tests/lib-push.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/lib-push.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { isPushConfigured, saveSubscription, removeSubscription, sendToPerson } from '../src/lib/push.js';

function seedKid(db, name = 'K') {
  return db.prepare("INSERT INTO people (name, role) VALUES (?, 'kid') RETURNING id").get(name).id;
}
function fakeSub(endpoint = 'https://push.example/abc') {
  return { endpoint, keys: { p256dh: 'pkey', auth: 'akey' } };
}

test('isPushConfigured returns false without VAPID env', () => {
  assert.equal(isPushConfigured(), false);
});

test('saveSubscription inserts a subscription', () => {
  const db = freshDb();
  const kid = seedKid(db);
  saveSubscription(db, kid, fakeSub());
  const rows = db.prepare('SELECT * FROM push_subscriptions WHERE person_id = ?').all(kid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].endpoint, 'https://push.example/abc');
  assert.equal(rows[0].p256dh, 'pkey');
});

test('saveSubscription on same endpoint updates, no duplicate', () => {
  const db = freshDb();
  const kid = seedKid(db);
  saveSubscription(db, kid, fakeSub());
  saveSubscription(db, kid, { endpoint: 'https://push.example/abc', keys: { p256dh: 'pkey2', auth: 'akey2' } });
  const rows = db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').all('https://push.example/abc');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].p256dh, 'pkey2');
});

test('removeSubscription deletes by endpoint', () => {
  const db = freshDb();
  const kid = seedKid(db);
  saveSubscription(db, kid, fakeSub());
  removeSubscription(db, 'https://push.example/abc');
  const rows = db.prepare('SELECT * FROM push_subscriptions').all();
  assert.equal(rows.length, 0);
});

test('sendToPerson is a safe no-op when not configured', async () => {
  const db = freshDb();
  const kid = seedKid(db);
  saveSubscription(db, kid, fakeSub());
  await sendToPerson(db, kid, { title: 'T', body: 'B', tag: 'x' });
  // no throw = pass
  assert.ok(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL — `src/lib/push.js` doesn't exist.

- [ ] **Step 3: Create `src/lib/push.js`**

```js
import webpush from 'web-push';

const PUBLIC = process.env.VAPID_PUBLIC_KEY;
const PRIVATE = process.env.VAPID_PRIVATE_KEY;
const SUBJECT = process.env.VAPID_SUBJECT;

let configured = false;
if (PUBLIC && PRIVATE && SUBJECT) {
  webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE);
  configured = true;
}

export function isPushConfigured() {
  return configured;
}

export function getPublicKey() {
  return PUBLIC || null;
}

export function saveSubscription(db, personId, subscription) {
  const { endpoint, keys } = subscription;
  db.prepare(`
    INSERT INTO push_subscriptions (person_id, endpoint, p256dh, auth)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      person_id = excluded.person_id,
      p256dh = excluded.p256dh,
      auth = excluded.auth
  `).run(personId, endpoint, keys.p256dh, keys.auth);
}

export function removeSubscription(db, endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

export async function sendToPerson(db, personId, payload) {
  if (!configured) return;
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE person_id = ?').all(personId);
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload)
      );
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      } else {
        console.error('push send failed:', err.message);
      }
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 158 tests (153 prior + 5 new).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/lib/push.js tests/lib-push.test.js && git commit -m "feat(lib/push): web-push wrapper with subscription storage and safe send"
```

---

## Task 3: `src/routes/push.js` + tests + mount

**Files:**
- Create: `src/routes/push.js`
- Create: `tests/routes-push.test.js`
- Modify: `src/app.js`

- [ ] **Step 1: Write failing tests**

Create `tests/routes-push.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';

async function loginKid(app, db) {
  const id = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id });
  return { agent, id };
}

test('GET /api/push/vapid-key returns 503 when not configured', async () => {
  const db = freshDb();
  const { agent } = await loginKid(freshApp(db), db);
  const res = await agent.get('/api/push/vapid-key');
  assert.equal(res.status, 503);
});

test('POST /api/push/subscribe saves a subscription', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const { agent, id } = await loginKid(app, db);
  const sub = { endpoint: 'https://push.example/xyz', keys: { p256dh: 'p', auth: 'a' } };
  const res = await agent.post('/api/push/subscribe').send(sub);
  assert.equal(res.status, 200);
  const rows = db.prepare('SELECT * FROM push_subscriptions WHERE person_id = ?').all(id);
  assert.equal(rows.length, 1);
});

test('POST /api/push/unsubscribe removes a subscription', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const { agent, id } = await loginKid(app, db);
  const sub = { endpoint: 'https://push.example/xyz', keys: { p256dh: 'p', auth: 'a' } };
  await agent.post('/api/push/subscribe').send(sub);
  const res = await agent.post('/api/push/unsubscribe').send({ endpoint: 'https://push.example/xyz' });
  assert.equal(res.status, 200);
  const rows = db.prepare('SELECT * FROM push_subscriptions').all();
  assert.equal(rows.length, 0);
});

test('push endpoints reject non-kid', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const res = await request(app).post('/api/push/subscribe').send({ endpoint: 'x', keys: {} });
  assert.equal(res.status, 401);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL — route doesn't exist (404, not 503/200).

- [ ] **Step 3: Create `src/routes/push.js`**

```js
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { isPushConfigured, getPublicKey, saveSubscription, removeSubscription } from '../lib/push.js';

export function pushRoutes() {
  const r = Router();
  r.use(requireRole('kid'));

  r.get('/push/vapid-key', (req, res) => {
    if (!isPushConfigured()) return res.status(503).json({ error: 'Push not configured' });
    res.json({ key: getPublicKey() });
  });

  r.post('/push/subscribe', (req, res) => {
    const db = req.app.get('db');
    const sub = req.body || {};
    if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    saveSubscription(db, req.user.person_id, sub);
    res.json({ ok: true });
  });

  r.post('/push/unsubscribe', (req, res) => {
    const db = req.app.get('db');
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
    removeSubscription(db, endpoint);
    res.json({ ok: true });
  });

  return r;
}
```

- [ ] **Step 4: Mount in `src/app.js`**

Add import (after the other route imports):

```js
import { pushRoutes } from './routes/push.js';
```

Add mount (after `app.use('/api', wallRoutes());`):

```js
  app.use('/api', pushRoutes());
```

- [ ] **Step 5: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 162 tests (158 prior + 4 new).

- [ ] **Step 6: Commit**

```bash
cd ~/projects/tally && git add src/routes/push.js tests/routes-push.test.js src/app.js && git commit -m "feat(routes/push): vapid-key + subscribe + unsubscribe endpoints"
```

---

## Task 4: `src/lib/scheduler.js` + tests

**Files:**
- Create: `src/lib/scheduler.js`
- Create: `tests/lib-scheduler.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/lib-scheduler.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { streakReminderDue } from '../src/lib/scheduler.js';
import { today, toIso } from '../src/lib/dates.js';

function seedKid(db, name = 'K') {
  return db.prepare("INSERT INTO people (name, role) VALUES (?, 'kid') RETURNING id").get(name).id;
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
function setWarning(db, hhmm) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('streak_warning_time', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(hhmm);
}

test('streakReminderDue returns kids at risk after warning time', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, daysAgo(1), 'done'); // streak = 1
  seedAssignment(db, c, kid, today(), 'pending'); // today incomplete
  setWarning(db, '00:00'); // warning time already passed
  const due = streakReminderDue(db);
  assert.equal(due.length, 1);
  assert.equal(due[0].personId, kid);
  assert.equal(due[0].streakDays, 1);
});

test('streakReminderDue empty when no kid at risk', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, today(), 'done'); // all done, not at risk
  setWarning(db, '00:00');
  const due = streakReminderDue(db);
  assert.equal(due.length, 0);
});

test('streakReminderDue excludes kids with streak 0', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const c = seedChore(db);
  seedAssignment(db, c, kid, today(), 'pending'); // streak 0, today incomplete
  setWarning(db, '00:00');
  const due = streakReminderDue(db);
  assert.equal(due.length, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL — `src/lib/scheduler.js` doesn't exist.

- [ ] **Step 3: Create `src/lib/scheduler.js`**

```js
import { today } from './dates.js';
import { currentStreak, streakAtRisk } from './streak.js';
import { sendToPerson } from './push.js';

export function streakReminderDue(db) {
  const warningRow = db.prepare("SELECT value FROM settings WHERE key='streak_warning_time'").get();
  const warningTime = warningRow ? warningRow.value : '20:00';
  const kids = db.prepare("SELECT id FROM people WHERE role = 'kid'").all();
  const due = [];
  for (const kid of kids) {
    const streak = currentStreak(db, kid.id);
    if (streakAtRisk(db, kid.id, warningTime, streak)) {
      due.push({ personId: kid.id, streakDays: streak });
    }
  }
  return due;
}

export function startScheduler(db) {
  const sent = new Set();
  let lastDate = today();

  setInterval(() => {
    try {
      const t = today();
      if (t !== lastDate) { sent.clear(); lastDate = t; }

      for (const { personId, streakDays } of streakReminderDue(db)) {
        const key = `${personId}:${t}`;
        if (sent.has(key)) continue;
        sent.add(key);
        sendToPerson(db, personId, {
          title: 'Streak at risk!',
          body: `Your ${streakDays} day streak ends tonight. Finish your chores!`,
          tag: 'streak',
        });
      }
    } catch (e) {
      console.error('scheduler tick failed:', e);
    }
  }, 60_000);
}
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 165 tests (162 prior + 3 new).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/lib/scheduler.js tests/lib-scheduler.test.js && git commit -m "feat(lib/scheduler): streakReminderDue + once-a-minute startScheduler"
```

---

## Task 5: Event triggers — bonus + payday

**Files:**
- Modify: `src/routes/admin/bonuses.js`
- Modify: `src/lib/payout.js`

- [ ] **Step 1: Modify `src/routes/admin/bonuses.js`**

Add import (after the existing imports):

```js
import { sendToPerson } from '../../lib/push.js';
```

In the `POST /bonuses` handler, the current code ends with:

```js
    res.json({ bonus });
    notifyWall();
  });
```

Change to:

```js
    res.json({ bonus });
    notifyWall();
    const kids = db.prepare("SELECT id FROM people WHERE role = 'kid'").all();
    for (const k of kids) {
      sendToPerson(db, k.id, { title: 'New bonus!', body: `${bonus.title} · +${bonus.points} pts`, tag: 'bonus' });
    }
  });
```

- [ ] **Step 2: Modify `src/lib/payout.js`**

Add import at top (after the existing imports):

```js
import { sendToPerson } from './push.js';
```

In `runPayoutIfDue`, the deposit transaction currently looks like:

```js
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
```

Change it to collect paid deposits and notify after the transaction commits:

```js
    const paid = [];
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
          paid.push({ personId: kid.id, earned });
        }
      }
    });
    deposit();

    for (const { personId, earned } of paid) {
      sendToPerson(db, personId, {
        title: 'Payday!',
        body: `$${(earned / 100).toFixed(2)} added to your bank`,
        tag: 'payday',
      });
    }
```

- [ ] **Step 3: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 165 tests (push is unconfigured in tests, so sendToPerson no-ops).

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add src/routes/admin/bonuses.js src/lib/payout.js && git commit -m "feat(push): notify kids on new bonus and payday deposit"
```

---

## Task 6: Service worker push handlers

**Files:**
- Modify: `public/sw.js`

- [ ] **Step 1: Replace `public/sw.js`**

```js
const SW_VERSION = 'v2-push';

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // no-op for now

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = data.title || 'Tally';
  const options = {
    body: data.body || '',
    tag: data.tag || 'tally',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) return w.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
```

- [ ] **Step 2: Verify icon path exists**

```bash
cd ~/projects/tally && ls public/icons/ 2>/dev/null || ls public/*.png 2>/dev/null || echo "NO ICONS - check manifest.json for icon paths"
```

If the icon path differs from `/icons/icon-192.png`, update the `icon` and `badge` values in sw.js to match the actual icon path referenced in `public/manifest.json`. (Read manifest.json to find the correct path.)

- [ ] **Step 3: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 165 tests (service worker is client-only, no test impact).

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add public/sw.js && git commit -m "feat(sw): push + notificationclick handlers"
```

---

## Task 7: Client push-client.js + home UI button

**Files:**
- Create: `public/js/lib/push-client.js`
- Modify: `public/js/pages/home.js`

- [ ] **Step 1: Create `public/js/lib/push-client.js`**

```js
import { api } from './api.js';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export function pushStatus() {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'unsupported';
  }
  return Notification.permission; // 'default' | 'granted' | 'denied'
}

export async function enablePush() {
  if (pushStatus() === 'unsupported') return { ok: false, reason: 'unsupported' };

  let keyRes;
  try {
    keyRes = await api.get('/api/push/vapid-key');
  } catch (e) {
    return { ok: false, reason: 'not-configured' };
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'denied' };

  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(keyRes.key),
  });

  await api.post('/api/push/subscribe', sub.toJSON());
  return { ok: true };
}
```

- [ ] **Step 2: Wire the button into `public/js/pages/home.js`**

Add import at top (after the existing imports):

```js
import { pushStatus, enablePush } from '../lib/push-client.js';
```

The current header looks like:

```js
    el('header', { class: 'app-header' }, [
      el('h1', {}, [`Hey ${p.name}`]),
      el('div', { class: 'av', style: { background: p.avatar_color } }, [p.name[0]]),
    ]),
```

Change to include a reminders button when status is 'default':

```js
    el('header', { class: 'app-header' }, [
      el('h1', {}, [`Hey ${p.name}`]),
      el('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
        pushStatus() === 'default'
          ? el('button', { class: 'btn btn-ghost btn-sm', onClick: async (e) => {
              e.target.disabled = true;
              e.target.textContent = '…';
              const result = await enablePush();
              if (result.ok) {
                e.target.remove();
              } else if (result.reason === 'denied') {
                e.target.textContent = 'Reminders blocked';
              } else {
                e.target.remove();
              }
            }}, ['Turn on reminders'])
          : null,
        el('div', { class: 'av', style: { background: p.avatar_color } }, [p.name[0]]),
      ].filter(Boolean)),
    ]),
```

- [ ] **Step 3: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 165 tests (client-only change).

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add public/js/lib/push-client.js public/js/pages/home.js && git commit -m "feat(home): opt-in Turn on reminders button + push client"
```

---

## Task 8: Wire startScheduler into server.js

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Modify `server.js`**

Add import (after the existing imports):

```js
import { startScheduler } from './src/lib/scheduler.js';
```

After the `generateForToday(db);` + its setInterval block (around line 21), add:

```js
startScheduler(db);
```

- [ ] **Step 2: Verify server boots**

```bash
cd ~/projects/tally && timeout 3 node server.js 2>&1 | head -3 || true
```

Expected: `Tally listening on http://localhost:3007` (or the PORT). No crash.

- [ ] **Step 3: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 165 tests (scheduler only starts via server.js, not buildApp, so tests don't spawn timers).

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add server.js && git commit -m "feat(server): start streak reminder scheduler"
```

---

## Task 9: Generate VAPID keys, deploy + tag v0.7.0-phase7

- [ ] **Step 1: Generate VAPID keys**

```bash
cd ~/projects/tally && node -e "import('web-push').then(w => { const k = w.default.generateVAPIDKeys(); console.log('VAPID_PUBLIC_KEY=' + k.publicKey); console.log('VAPID_PRIVATE_KEY=' + k.privateKey); })"
```

- [ ] **Step 2: Add keys to `.env`**

Append the two printed lines plus the subject to `~/projects/tally/.env`:

```
VAPID_PUBLIC_KEY=<printed public key>
VAPID_PRIVATE_KEY=<printed private key>
VAPID_SUBJECT=mailto:jeffrey@thelopezfamily.org
```

(`.env` is gitignored — do not commit the keys.)

- [ ] **Step 3: Final test run**

```bash
cd ~/projects/tally && npm test
```

Expected: 165 tests pass.

- [ ] **Step 4: Reload PM2 with env + verify**

```bash
cd ~/projects/tally && pm2 reload tally --update-env
sleep 3
curl -sf http://localhost:3012/api/health
```

Expected: `{"ok":true}`.

- [ ] **Step 5: Verify push is configured in production**

```bash
cd ~/projects/tally && node -e "import('dotenv/config').then(() => import('./src/lib/push.js')).then(m => console.log('configured:', m.isPushConfigured()))" 2>/dev/null || echo "Note: verify via the kid home button appearing instead"
```

Note: the app itself reads env from PM2's environment, not a dotenv import. The real verification is that the "Turn on reminders" button appears on a kid's phone. If the app does not use dotenv, confirm PM2 was started with the env vars present (pm2 reload --update-env picks up the current shell env, so `.env` must be sourced or the vars exported before reload). If PM2 does not pick them up, set them via `pm2 set` or ensure the ecosystem config loads `.env`.

- [ ] **Step 6: Tag the release**

```bash
cd ~/projects/tally && git tag v0.7.0-phase7 && git log --oneline -12 && git tag -l 'v*'
```

---

## Self-Review

**Spec coverage:**

| Spec section | Covered by Task(s) |
|---|---|
| §1 Summary | All tasks |
| §2 Goals (streak, payday, bonus, opt-in, graceful) | Tasks 2-8 |
| §3 Non-goals | Honored (no parent notif, no morning nudge, no center) |
| §4 Dependency (web-push) | Task 1 |
| §5 Configuration (VAPID env) | Tasks 2, 9 |
| §6 Schema | Task 1 |
| §7 push.js module | Task 2 |
| §8 Subscription endpoints | Task 3 |
| §9 Event triggers (bonus, payday) | Task 5 |
| §10 Scheduler | Task 4, wired in Task 8 |
| §11 Service worker | Task 6 |
| §12 Client subscription | Task 7 |
| §13 Kid home UI | Task 7 |
| §14 Tests | Tasks 2, 3, 4 |
| §15 Tech notes | Implementation in Tasks 2-8 |
| §16 Acceptance test | Task 9 |

**Placeholder scan:** Every step has complete code or exact commands. Task 6 Step 2 and Task 9 Step 5 contain conditional verification instructions (check icon path, confirm PM2 env) — these are genuine environment checks with explicit fallback actions, not placeholders.

**Type consistency:**
- `sendToPerson(db, personId, payload)` consistent across push.js (Task 2), scheduler.js (Task 4), bonuses.js + payout.js (Task 5)
- payload shape `{ title, body, tag }` consistent everywhere
- `saveSubscription(db, personId, subscription)` / `removeSubscription(db, endpoint)` consistent between push.js (Task 2) and routes (Task 3)
- `isPushConfigured()` / `getPublicKey()` consistent between push.js (Task 2) and routes (Task 3)
- `streakReminderDue(db)` returns `[{ personId, streakDays }]` consistent between scheduler.js definition and startScheduler consumer (Task 4)
- `pushStatus()` / `enablePush()` consistent between push-client.js (Task 7) and home.js (Task 7)

Plan is internally consistent.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-27-tally-phase-7-web-push.md`. 9 tasks. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks

**2. Inline Execution** — I execute directly in this session (has worked well for recent phases)

Which approach?
