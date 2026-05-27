# Tally — Phase 5 SSE Realtime Wall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the wall's 10-second polling with instant Server-Sent Events so chore completions, steals, and approvals appear on the wall display within ~200ms.

**Architecture:** A singleton Node EventEmitter (`wallBus`) lives in `src/lib/events.js`. Mutation endpoints call `notifyWall()` (debounced 100ms) after their DB write. A new SSE endpoint `GET /api/wall/events` pushes `event: refresh` to connected wall clients. The wall.js client opens an `EventSource` and calls its existing `render()` on each event. The 10s poll stays as fallback.

**Tech Stack:** Node 20+ EventEmitter, native browser EventSource. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-05-27-tally-phase-5-sse-realtime.md`](../specs/2026-05-27-tally-phase-5-sse-realtime.md)

---

## File Structure

```
~/projects/tally/
├── src/
│   ├── lib/
│   │   └── events.js                               NEW: wallBus + notifyWall
│   └── routes/
│       ├── home.js                                  MODIFY: notifyWall in 4 mutation endpoints
│       ├── wall.js                                  MODIFY: add GET /api/wall/events SSE endpoint
│       └── admin/
│           ├── approvals.js                         MODIFY: notifyWall in approve + reject
│           └── bonuses.js                           MODIFY: notifyWall in POST + DELETE
├── public/
│   └── js/pages/
│       └── wall.js                                  MODIFY: add EventSource listener
└── tests/
    ├── lib-events.test.js                           NEW: wallBus + debounce unit tests
    └── sse-wall.test.js                             NEW: SSE endpoint integration tests
```

---

## Task 1: `src/lib/events.js` with wallBus + notifyWall

**Files:**
- Create: `src/lib/events.js`
- Create: `tests/lib-events.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/lib-events.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wallBus, notifyWall } from '../src/lib/events.js';

test('notifyWall emits refresh on wallBus', async () => {
  const refreshed = new Promise(resolve => wallBus.once('refresh', resolve));
  notifyWall();
  await Promise.race([
    refreshed,
    new Promise((_, rej) => setTimeout(() => rej(new Error('wallBus did not fire')), 500)),
  ]);
});

test('notifyWall debounces rapid calls into a single refresh', async () => {
  let count = 0;
  const handler = () => count++;
  wallBus.on('refresh', handler);

  notifyWall();
  notifyWall();
  notifyWall();

  await new Promise(r => setTimeout(r, 300));
  wallBus.off('refresh', handler);
  assert.equal(count, 1);
});

test('notifyWall fires again after debounce window passes', async () => {
  let count = 0;
  const handler = () => count++;
  wallBus.on('refresh', handler);

  notifyWall();
  await new Promise(r => setTimeout(r, 200));
  notifyWall();
  await new Promise(r => setTimeout(r, 200));

  wallBus.off('refresh', handler);
  assert.equal(count, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL — `src/lib/events.js` doesn't exist.

- [ ] **Step 3: Create `src/lib/events.js`**

```js
import { EventEmitter } from 'node:events';

export const wallBus = new EventEmitter();
wallBus.setMaxListeners(20);

let timer = null;
export function notifyWall() {
  clearTimeout(timer);
  timer = setTimeout(() => wallBus.emit('refresh'), 100);
}
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 134 tests (131 prior + 3 new).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/lib/events.js tests/lib-events.test.js && git commit -m "feat(lib/events): wallBus + debounced notifyWall"
```

---

## Task 2: SSE endpoint `GET /api/wall/events`

**Files:**
- Modify: `src/routes/wall.js`
- Create: `tests/sse-wall.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/sse-wall.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { freshApp, freshDb } from './helpers.js';
import { wallBus, notifyWall } from '../src/lib/events.js';

function sseRequest(port, opts = {}) {
  const timeout = opts.timeout || 2000;
  return new Promise((resolve, reject) => {
    let data = '';
    const req = http.get(`http://localhost:${port}/api/wall/events`, (res) => {
      res.on('data', (chunk) => {
        data += chunk.toString();
        if (opts.until && opts.until(data)) {
          req.destroy();
          resolve({ data, headers: res.headers });
        }
      });
    });
    req.on('error', () => {});
    setTimeout(() => { req.destroy(); resolve({ data, headers: null }); }, timeout);
  });
}

test('GET /api/wall/events returns SSE headers and initial :ok comment', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const server = app.listen(0);
  const port = server.address().port;

  const { data, headers } = await sseRequest(port, {
    until: (d) => d.includes(':ok'),
    timeout: 1000,
  });

  server.close();
  assert.equal(headers['content-type'], 'text/event-stream');
  assert.equal(headers['cache-control'], 'no-cache');
  assert.ok(data.includes(':ok'));
});

test('notifyWall sends refresh event through SSE stream', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const server = app.listen(0);
  const port = server.address().port;

  const result = sseRequest(port, {
    until: (d) => d.includes('event: refresh'),
    timeout: 1000,
  });

  await new Promise(r => setTimeout(r, 50));
  notifyWall();

  const { data } = await result;
  server.close();
  assert.ok(data.includes('event: refresh'));
  assert.ok(data.includes('data: {}'));
});

test('SSE cleans up wallBus listener on client disconnect', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const server = app.listen(0);
  const port = server.address().port;
  const before = wallBus.listenerCount('refresh');

  await new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/api/wall/events`, (res) => {
      res.once('data', () => {
        req.destroy();
        setTimeout(resolve, 100);
      });
    });
    req.on('error', () => {});
  });

  server.close();
  assert.equal(wallBus.listenerCount('refresh'), before);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL — `/api/wall/events` returns 404 (no route).

- [ ] **Step 3: Modify `src/routes/wall.js`**

Add import at the top (after the existing imports):

```js
import { wallBus } from '../lib/events.js';
```

Add the SSE route BEFORE the existing `r.get('/wall', ...)` (Express matches first-registered route, and `/wall/events` must not be caught by a `/wall` prefix):

```js
  r.get('/wall/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':ok\n\n');

    const onRefresh = () => res.write('event: refresh\ndata: {}\n\n');
    wallBus.on('refresh', onRefresh);
    req.on('close', () => wallBus.off('refresh', onRefresh));
  });
```

The full top of wall.js should now look like:

```js
import { Router } from 'express';
import { today, weekStart } from '../lib/dates.js';
import { calcWeekPoints } from '../lib/points.js';
import { currentStreak, isOnFreeze } from '../lib/streak.js';
import { wallBus } from '../lib/events.js';

export function wallRoutes() {
  const r = Router();

  r.get('/wall/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':ok\n\n');

    const onRefresh = () => res.write('event: refresh\ndata: {}\n\n');
    wallBus.on('refresh', onRefresh);
    req.on('close', () => wallBus.off('refresh', onRefresh));
  });

  r.get('/wall', (req, res) => {
    // ... existing wall handler unchanged ...
  });

  return r;
}
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 137 tests (134 prior + 3 new).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/routes/wall.js tests/sse-wall.test.js && git commit -m "feat(wall): GET /api/wall/events SSE endpoint"
```

---

## Task 3: Wire `notifyWall()` into all mutation endpoints

**Files:**
- Modify: `src/routes/home.js`
- Modify: `src/routes/admin/approvals.js`
- Modify: `src/routes/admin/bonuses.js`

- [ ] **Step 1: Modify `src/routes/home.js`**

Add import at line 7 (after the streak import):

```js
import { notifyWall } from '../lib/events.js';
```

There are 4 mutation endpoints. Add `notifyWall();` after each successful `res.json(...)`:

**a) `POST /api/assignments/:id/undo`** (around line 132):

Change:
```js
    res.json({ ok: true, status: 'pending' });
  });
```
To:
```js
    res.json({ ok: true, status: 'pending' });
    notifyWall();
  });
```

**b) `POST /api/assignments/:id/steal`** (around line 162):

Change:
```js
    res.json({ ok: true });
  });
```
To:
```js
    res.json({ ok: true });
    notifyWall();
  });
```

**c) `POST /api/bonuses/:id/claim`** (around line 183):

Change:
```js
    res.json({ ok: true, assignment_id: row.id });
  });
```
To:
```js
    res.json({ ok: true, assignment_id: row.id });
    notifyWall();
  });
```

**d) `doSubmit` function** — three return paths need notifyWall:

Honor path (around line 220):
```js
    return res.json({ ok: true, status: 'done' });
```
Change to:
```js
    res.json({ ok: true, status: 'done' });
    notifyWall();
    return;
```

Approval path (around line 229):
```js
    return res.json({ ok: true, status: 'submitted' });
```
Change to:
```js
    res.json({ ok: true, status: 'submitted' });
    notifyWall();
    return;
```

Photo path (inside the `.then()`, around line 243):
```js
      res.json({ ok: true, status: 'submitted' });
```
Change to:
```js
      res.json({ ok: true, status: 'submitted' });
      notifyWall();
```

- [ ] **Step 2: Modify `src/routes/admin/approvals.js`**

Add import at top (after the existing imports):

```js
import { notifyWall } from '../../lib/events.js';
```

**a) `POST /api/admin/approvals/:id/approve`** (around line 47):

Change:
```js
    res.json({ ok: true });
  });
```
To:
```js
    res.json({ ok: true });
    notifyWall();
  });
```

**b) `POST /api/admin/approvals/:id/reject`** (around line 63):

Change:
```js
    res.json({ ok: true });
  });
```
To:
```js
    res.json({ ok: true });
    notifyWall();
  });
```

- [ ] **Step 3: Modify `src/routes/admin/bonuses.js`**

Add import at top (after the existing imports):

```js
import { notifyWall } from '../../lib/events.js';
```

**a) `POST /api/admin/bonuses`** (around line 50):

Change:
```js
    res.json({ bonus });
  });
```
To:
```js
    res.json({ bonus });
    notifyWall();
  });
```

**b) `DELETE /api/admin/bonuses/:id`** (around line 80):

Change:
```js
    res.json({ ok: true });
  });
```
To:
```js
    res.json({ ok: true });
    notifyWall();
  });
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 137 tests (no new tests, but existing tests still pass with the added notifyWall calls).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/routes/home.js src/routes/admin/approvals.js src/routes/admin/bonuses.js && git commit -m "feat: wire notifyWall into all 8 mutation endpoints"
```

---

## Task 4: Wall client EventSource

**Files:**
- Modify: `public/js/pages/wall.js`

- [ ] **Step 1: Add EventSource listener**

At the bottom of `public/js/pages/wall.js`, after the existing lines:

```js
render();
setInterval(render, 10_000);
```

Add:

```js
const sse = new EventSource('/api/wall/events');
sse.addEventListener('refresh', () => render());
```

The full file ending should look like:

```js
render();
setInterval(render, 10_000);

const sse = new EventSource('/api/wall/events');
sse.addEventListener('refresh', () => render());
```

- [ ] **Step 2: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 137 tests (no new tests, pure frontend change).

- [ ] **Step 3: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/wall.js && git commit -m "feat(wall): EventSource listener for instant refresh via SSE"
```

---

## Task 5: Deploy + tag v0.5.0-phase5

- [ ] **Step 1: Final test run**

```bash
cd ~/projects/tally && npm test
```

Expected: 137 tests pass.

- [ ] **Step 2: Reload PM2 + verify health**

```bash
cd ~/projects/tally && pm2 reload tally
sleep 3
curl -sf http://localhost:3012/api/health
```

Expected: `{"ok":true}`.

- [ ] **Step 3: Verify SSE endpoint is live**

```bash
curl -sf -N http://localhost:3012/api/wall/events &
SSE_PID=$!
sleep 1
kill $SSE_PID 2>/dev/null
```

Expected: stream begins with `:ok` comment (visible in terminal output).

- [ ] **Step 4: Tag the release**

```bash
cd ~/projects/tally && git tag v0.5.0-phase5 && git log --oneline -8 && git tag -l 'v*'
```

---

## Self-Review

**Spec coverage:**

| Spec section | Covered by Task(s) |
|---|---|
| §1 Summary | All tasks together |
| §2 Goals (instant, zero deps, minimal, graceful) | Tasks 1-4 collectively |
| §3 Non-goals | Honored (no home/admin SSE, no granular events, no auth) |
| §4 Architecture: event bus | Task 1 |
| §4 Architecture: SSE endpoint | Task 2 |
| §4 Architecture: mutation touchpoints (8 endpoints) | Task 3 |
| §4 Architecture: client EventSource | Task 4 |
| §5 Schema (none) | No migration tasks |
| §6 API surface | Task 2 (new endpoint), Task 3 (modified endpoints) |
| §7 Error handling | Task 2 (close cleanup), Task 1 (debounce), Task 4 (fallback poll kept) |
| §8 Tests | Tasks 1-2 |
| §9 Tech notes | Implementation details in Tasks 1-4 |
| §10 Acceptance test | Task 5 |

**Placeholder scan:** Every step has executable code or commands. No TBDs.

**Type consistency:**
- `wallBus` and `notifyWall` exported from `src/lib/events.js`, imported identically in Tasks 2 and 3
- Event name `'refresh'` consistent across emitter (Task 1), SSE writer (Task 2), and client listener (Task 4)
- SSE event format `event: refresh\ndata: {}\n\n` consistent between Task 2 implementation and Task 2 tests

Plan is internally consistent.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-27-tally-phase-5-sse-realtime.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session, batch execution with checkpoints

Which approach?
