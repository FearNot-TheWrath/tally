# Tally — Phase 1 (Skeleton) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Tally MVP: a deployable web app the family can start using today. Three surfaces (profile picker → kid home, wall display at `/wall`, parent admin with People + Chores + Today), backed by SQLite with a schema ready for later phases.

**Architecture:** Single Node/Express server with better-sqlite3, serving a vanilla-JS SPA and a separate wall page. Authentication via signed session cookies (no PIN for kids, PIN for parents). Recurring chores are materialized into per-day `assignments` rows by an hourly job. No realtime in Phase 1 — wall polls every 10 seconds. No points credit yet (Phase 2). The visual system is Style C from the spec.

**Tech Stack:**
- Runtime: Node.js 20+
- Server: Express 5, better-sqlite3, cookie-session, scrypt (built-in `node:crypto`)
- Tests: `node:test` (built-in), `supertest`
- Frontend: Vanilla JS (no build), Inter + JetBrains Mono via Google Fonts
- Deploy: PM2 on acutis-box, port 3007, Cloudflare Tunnel → `tally.thelopezfamily.org`

**Scope guardrails (deferred to later phases):** points credit / ledger / weekly settle (Phase 2), photo + approval workflow (Phase 3), bonus board (Phase 4), SSE realtime (Phase 5), streaks + confetti + dark-mode toggle (Phase 6), Web Push (Phase 7).

**Spec:** [`docs/superpowers/specs/2026-05-26-tally-design.md`](../specs/2026-05-26-tally-design.md)

---

## File Structure

```
~/projects/tally/
├── package.json
├── ecosystem.config.js              -- PM2 config
├── .gitignore
├── README.md
├── server.js                        -- Entry point
├── tally.db                         -- Created on first run (gitignored)
├── src/
│   ├── db.js                        -- better-sqlite3 setup + migration runner
│   ├── migrations/
│   │   ├── 001-people-sessions-settings.sql
│   │   ├── 002-chores-assignments.sql
│   │   └── 003-seed-defaults.sql
│   ├── auth.js                      -- session middleware + scrypt helpers
│   ├── routes/
│   │   ├── auth.js                  -- /api/auth/*
│   │   ├── home.js                  -- /api/home, /api/assignments/:id/done
│   │   ├── wall.js                  -- /api/wall
│   │   └── admin/
│   │       ├── people.js            -- /api/admin/people*
│   │       ├── chores.js            -- /api/admin/chores*
│   │       └── today.js             -- /api/admin/today (dashboard)
│   └── lib/
│       ├── dates.js                 -- today(), weekStart(), isToday(), isOverdue()
│       └── assignments.js           -- generateForToday(): materialize recurring
└── public/
    ├── index.html                   -- The SPA shell
    ├── wall.html                    -- The wall display
    ├── manifest.json
    ├── sw.js
    ├── css/
    │   ├── tokens.css               -- :root design tokens
    │   ├── base.css                 -- resets, body, type
    │   ├── components.css           -- hero, txn rows, buttons, cards
    │   └── layouts.css              -- picker, kid home, admin, wall
    └── js/
        ├── app.js                   -- SPA router + boot
        ├── pages/
        │   ├── picker.js
        │   ├── home.js
        │   ├── admin.js
        │   └── wall.js              -- loaded by wall.html only
        └── lib/
            ├── api.js               -- fetch wrapper with cookie + JSON
            └── dom.js               -- $, $$, el() helpers

tests/
├── helpers.js                       -- buildApp() helper for supertest
├── auth.test.js
├── home.test.js
├── wall.test.js
├── admin-people.test.js
├── admin-chores.test.js
└── assignments-generator.test.js
```

Each backend route file is one resource. Each frontend page file is one screen. Tests live in `tests/`. Migrations are plain `.sql` files run in lexical order. This keeps each file focused and small.

---

## Task 1: Project initialization

**Files:**
- Create: `package.json`, `.gitignore`, `README.md`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "tally",
  "version": "0.1.0",
  "description": "Household chores + allowance app for the Lopez family",
  "main": "server.js",
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js",
    "test": "node --test tests/"
  },
  "engines": { "node": ">=20" },
  "dependencies": {
    "better-sqlite3": "^11.5.0",
    "cookie-session": "^2.1.0",
    "express": "^5.0.0"
  },
  "devDependencies": {
    "supertest": "^7.0.0"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
tally.db
tally.db-journal
uploads/
.env
.DS_Store
.superpowers/
```

- [ ] **Step 3: Install dependencies**

Run: `cd ~/projects/tally && npm install`
Expected: `node_modules/` populated, `package-lock.json` created.

- [ ] **Step 4: Create minimal `README.md`**

```markdown
# Tally

Household chores + allowance for the Lopez family.

## Dev
\`\`\`bash
npm install
npm run dev
\`\`\`
Open http://localhost:3007

## Test
\`\`\`bash
npm test
\`\`\`

See `docs/superpowers/specs/` for the design spec.
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore README.md
git commit -m "chore: project init"
```

---

## Task 2: Database module + first migration (people, sessions, settings)

**Files:**
- Create: `src/db.js`, `src/migrations/001-people-sessions-settings.sql`
- Test: `tests/helpers.js`

- [ ] **Step 1: Write the failing test**

Create `tests/helpers.js`:

```js
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';

export function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}
```

Create `tests/auth.test.js` (we'll expand it later — this is the smoke test):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';

test('migrations create people, sessions, settings tables', () => {
  const db = freshDb();
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name);
  assert.ok(tables.includes('people'));
  assert.ok(tables.includes('sessions'));
  assert.ok(tables.includes('settings'));
  assert.ok(tables.includes('_migrations'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '../src/db.js'`

- [ ] **Step 3: Create `src/migrations/001-people-sessions-settings.sql`**

```sql
CREATE TABLE people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  dob TEXT,
  role TEXT NOT NULL CHECK (role IN ('kid','parent','wall')),
  avatar_color TEXT NOT NULL DEFAULT '#6366F1',
  weekly_target_pts INTEGER NOT NULL DEFAULT 0,
  base_pay_cents INTEGER NOT NULL DEFAULT 0,
  bonus_rate_cents INTEGER NOT NULL DEFAULT 0,
  bank_cents INTEGER NOT NULL DEFAULT 0,
  streak_days INTEGER NOT NULL DEFAULT 0,
  streak_last_date TEXT,
  freeze_start TEXT,
  freeze_end TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  device_fp TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sessions_person ON sessions(person_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

- [ ] **Step 4: Create `src/db.js`**

```js
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

export function openDb(path = './tally.db') {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

export function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      run_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map(r => r.name)
  );
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${e.message}`);
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS — the migrations smoke test runs green.

- [ ] **Step 6: Commit**

```bash
git add src/db.js src/migrations/001-people-sessions-settings.sql tests/helpers.js tests/auth.test.js
git commit -m "feat(db): migration runner and 001 people/sessions/settings schema"
```

---

## Task 3: Second migration (chores, assignments)

**Files:**
- Create: `src/migrations/002-chores-assignments.sql`

- [ ] **Step 1: Extend the smoke test**

Edit `tests/auth.test.js`, add below the existing test:

```js
test('migrations create chores and assignments tables', () => {
  const db = freshDb();
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'"
  ).all().map(r => r.name);
  assert.ok(tables.includes('chores'));
  assert.ok(tables.includes('assignments'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — chores/assignments tables don't exist.

- [ ] **Step 3: Create `src/migrations/002-chores-assignments.sql`**

```sql
CREATE TABLE chores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  points INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'recurring' CHECK (kind IN ('recurring','bonus','one-off')),
  recurs TEXT NOT NULL DEFAULT 'none' CHECK (recurs IN ('none','daily','weekly','biweekly','monthly')),
  recurs_days TEXT NOT NULL DEFAULT '',
  recurs_anchor TEXT,
  due_time TEXT,
  anti_cheat TEXT NOT NULL DEFAULT 'honor' CHECK (anti_cheat IN ('honor','photo','approval')),
  late_tax_pct INTEGER,
  photo_prompt TEXT NOT NULL DEFAULT '',
  default_assignees TEXT NOT NULL DEFAULT '',
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_chores_kind ON chores(kind) WHERE deleted_at IS NULL;

CREATE TABLE assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chore_id INTEGER NOT NULL REFERENCES chores(id),
  person_id INTEGER REFERENCES people(id),
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in-progress','submitted','done','rejected','expired')),
  submitted_at TEXT,
  approved_at TEXT,
  approved_by INTEGER REFERENCES people(id),
  photo_path TEXT,
  note TEXT NOT NULL DEFAULT '',
  points_earned INTEGER NOT NULL DEFAULT 0,
  late INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_assignments_person_date ON assignments(person_id, due_date);
CREATE INDEX idx_assignments_status ON assignments(status);
CREATE UNIQUE INDEX idx_assignments_unique ON assignments(chore_id, person_id, due_date);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/migrations/002-chores-assignments.sql tests/auth.test.js
git commit -m "feat(db): 002 chores and assignments schema"
```

---

## Task 4: Seed migration (default admin PIN)

**Files:**
- Create: `src/migrations/003-seed-defaults.sql`
- Create: `src/lib/scrypt.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/auth.test.js`:

```js
test('seed migration sets default admin PIN', () => {
  const db = freshDb();
  const row = db.prepare("SELECT value FROM settings WHERE key='admin_pin_hash'").get();
  assert.ok(row, 'admin_pin_hash should exist');
  assert.ok(row.value.length > 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `admin_pin_hash` not set.

- [ ] **Step 3: Create `src/lib/scrypt.js`**

```js
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const KEYLEN = 64;

export function hashPin(pin) {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, KEYLEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPin(pin, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(pin, salt, KEYLEN);
  return timingSafeEqual(expected, actual);
}
```

- [ ] **Step 4: Create `src/migrations/003-seed-defaults.sql`**

This migration is a plain SQL file but needs scrypt-hashed value. We'll hash the default PIN `1234` once and commit the resulting hash directly. Generate the hash by running this one-liner and copying the output:

```bash
node -e "import('./src/lib/scrypt.js').then(m => console.log(m.hashPin('1234')))"
```

Use the output (it looks like `aaaa...:bbbb...`) in the file below — paste your actual output in place of `<PIN_HASH>`:

```sql
INSERT INTO settings (key, value) VALUES
  ('admin_pin_hash', '<PIN_HASH>'),
  ('late_tax_pct_default', '50'),
  ('reminder_time', '16:00'),
  ('payout_day', '0'),
  ('payout_time', '19:00'),
  ('photo_retention_days', '90'),
  ('wall_theme', 'system');

-- A default "wall" identity for the wall display (no auth, but exists for joins).
INSERT INTO people (name, role, avatar_color) VALUES ('Wall', 'wall', '#0F172A');
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/scrypt.js src/migrations/003-seed-defaults.sql tests/auth.test.js
git commit -m "feat(db): 003 seed defaults (admin PIN, settings, wall identity)"
```

---

## Task 5: Date helpers

**Files:**
- Create: `src/lib/dates.js`
- Test: `tests/dates.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/dates.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { today, weekStart, isToday, isOverdue, dayOfWeek } from '../src/lib/dates.js';

test('today returns ISO date YYYY-MM-DD', () => {
  const t = today();
  assert.match(t, /^\d{4}-\d{2}-\d{2}$/);
});

test('weekStart returns the Monday ISO date for a given date', () => {
  // 2026-05-26 is a Tuesday; Monday is 2026-05-25
  assert.equal(weekStart('2026-05-26'), '2026-05-25');
  // 2026-05-25 is the Monday itself
  assert.equal(weekStart('2026-05-25'), '2026-05-25');
  // 2026-05-24 is a Sunday; Monday before is 2026-05-18
  assert.equal(weekStart('2026-05-24'), '2026-05-18');
});

test('isToday compares date to today()', () => {
  assert.equal(isToday(today()), true);
  assert.equal(isToday('2000-01-01'), false);
});

test('isOverdue is true for dates earlier than today', () => {
  assert.equal(isOverdue('2000-01-01'), true);
  assert.equal(isOverdue(today()), false);
});

test('dayOfWeek returns 0-6 (Sun-Sat)', () => {
  assert.equal(dayOfWeek('2026-05-26'), 2); // Tuesday
  assert.equal(dayOfWeek('2026-05-24'), 0); // Sunday
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/dates.js`**

```js
export function today() {
  const d = new Date();
  return toIso(d);
}

export function toIso(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function fromIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function weekStart(iso) {
  const d = fromIso(iso);
  const day = d.getDay(); // 0 Sun .. 6 Sat
  const offset = day === 0 ? -6 : 1 - day; // back to Monday
  d.setDate(d.getDate() + offset);
  return toIso(d);
}

export function isToday(iso) {
  return iso === today();
}

export function isOverdue(iso) {
  return iso < today();
}

export function dayOfWeek(iso) {
  return fromIso(iso).getDay();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dates.js tests/dates.test.js
git commit -m "feat(lib): date helpers (today, weekStart, isOverdue, dayOfWeek)"
```

---

## Task 6: Express app skeleton + supertest helper

**Files:**
- Create: `server.js`, `src/app.js`
- Test: extend `tests/helpers.js`

- [ ] **Step 1: Create `src/app.js`**

```js
import express from 'express';
import cookieSession from 'cookie-session';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildApp({ db, sessionSecret = 'dev-secret' }) {
  const app = express();
  app.set('db', db);
  app.use(express.json({ limit: '8mb' }));
  app.use(cookieSession({
    name: 'tally_session',
    keys: [sessionSecret],
    maxAge: 365 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    httpOnly: true,
  }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.use(express.static(join(__dirname, '..', 'public')));

  return app;
}
```

- [ ] **Step 2: Create `server.js`**

```js
import { openDb } from './src/db.js';
import { buildApp } from './src/app.js';

const PORT = process.env.PORT || 3007;
const SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';

const db = openDb('./tally.db');
const app = buildApp({ db, sessionSecret: SECRET });

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Tally listening on http://localhost:${PORT}`);
});
```

- [ ] **Step 3: Extend `tests/helpers.js`**

Replace the existing contents with:

```js
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';
import { buildApp } from '../src/app.js';

export function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

export function freshApp(db) {
  return buildApp({ db: db || freshDb(), sessionSecret: 'test-secret' });
}
```

- [ ] **Step 4: Add a smoke test for the app**

Create `tests/app.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp } from './helpers.js';

test('GET /api/health returns ok', async () => {
  const app = freshApp();
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Start the server manually to verify**

Run: `npm run dev`
Then in another shell: `curl http://localhost:3007/api/health`
Expected: `{"ok":true}`
Stop the dev server (Ctrl-C).

- [ ] **Step 7: Commit**

```bash
git add server.js src/app.js tests/helpers.js tests/app.test.js
git commit -m "feat(server): Express app skeleton with health endpoint"
```

---

## Task 7: Auth module — session + parent PIN verification

**Files:**
- Create: `src/auth.js`

- [ ] **Step 1: Write the failing test**

Create `tests/auth-module.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { createSession, getSession, requireRole, verifyParentPin } from '../src/auth.js';

test('createSession returns a token and inserts a row', () => {
  const db = freshDb();
  const personId = db.prepare(
    "INSERT INTO people (name, role) VALUES ('Test', 'kid') RETURNING id"
  ).get().id;
  const token = createSession(db, personId, { ua: 'test' });
  assert.ok(typeof token === 'string' && token.length >= 32);
  const session = getSession(db, token);
  assert.equal(session.person_id, personId);
});

test('verifyParentPin returns true for the default PIN and false otherwise', () => {
  const db = freshDb();
  assert.equal(verifyParentPin(db, '1234'), true);
  assert.equal(verifyParentPin(db, '0000'), false);
});

test('requireRole allows matching role, rejects mismatch', () => {
  const db = freshDb();
  const kidId = db.prepare("INSERT INTO people (name, role) VALUES ('K', 'kid') RETURNING id").get().id;
  const parentId = db.prepare("INSERT INTO people (name, role) VALUES ('P', 'parent') RETURNING id").get().id;

  const allowKid = requireRole('kid');
  const allowParent = requireRole('parent');

  const reqKid = { app: { get: () => db }, session: { token: createSession(db, kidId, {}) } };
  const reqParent = { app: { get: () => db }, session: { token: createSession(db, parentId, {}) } };

  let nextCalled, statusCode;
  const res = { status(c) { statusCode = c; return this; }, json() { return this; } };
  const next = () => { nextCalled = true; };

  // Kid into kid-only: passes.
  nextCalled = false;
  allowKid(reqKid, res, next);
  assert.equal(nextCalled, true);

  // Kid into parent-only: rejected.
  nextCalled = false; statusCode = 0;
  allowParent(reqKid, res, next);
  assert.equal(nextCalled, false);
  assert.equal(statusCode, 403);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/auth.js` not found.

- [ ] **Step 3: Create `src/auth.js`**

```js
import { randomBytes } from 'node:crypto';
import { verifyPin } from './lib/scrypt.js';

export function createSession(db, personId, { ua = '', deviceFp = '' } = {}) {
  const token = randomBytes(24).toString('hex');
  db.prepare(`
    INSERT INTO sessions (id, person_id, user_agent, device_fp)
    VALUES (?, ?, ?, ?)
  `).run(token, personId, ua, deviceFp);
  return token;
}

export function getSession(db, token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT s.id, s.person_id, s.last_seen, p.role, p.name
    FROM sessions s JOIN people p ON p.id = s.person_id
    WHERE s.id = ?
  `).get(token);
  if (!row) return null;
  db.prepare('UPDATE sessions SET last_seen = datetime(\'now\') WHERE id = ?').run(token);
  return row;
}

export function destroySession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
}

export function verifyParentPin(db, pin) {
  const row = db.prepare("SELECT value FROM settings WHERE key='admin_pin_hash'").get();
  if (!row) return false;
  try { return verifyPin(pin, row.value); }
  catch { return false; }
}

export function currentUser(req) {
  const db = req.app.get('db');
  const token = req.session?.token;
  return getSession(db, token);
}

export function requireRole(role) {
  return (req, res, next) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    if (user.role !== role) return res.status(403).json({ error: 'Forbidden' });
    req.user = user;
    next();
  };
}

export function requireAnyAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  next();
}
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth.js tests/auth-module.test.js
git commit -m "feat(auth): sessions, parent PIN verification, role middleware"
```

---

## Task 8: Auth routes — picker, login (kid + parent), logout, me

**Files:**
- Create: `src/routes/auth.js`
- Modify: `src/app.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/routes-auth.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';

function seed(db) {
  db.prepare("INSERT INTO people (name, role, avatar_color) VALUES ('Gabriel','kid','#22C55E')").run();
  db.prepare("INSERT INTO people (name, role, avatar_color) VALUES ('Mom','parent','#0F172A')").run();
}

test('GET /api/auth/picker lists kids and parents (no auth required)', async () => {
  const db = freshDb();
  seed(db);
  const app = freshApp(db);
  const res = await request(app).get('/api/auth/picker');
  assert.equal(res.status, 200);
  assert.equal(res.body.people.length, 2);
  assert.ok(res.body.people.find(p => p.name === 'Gabriel' && p.role === 'kid'));
});

test('POST /api/auth/login as kid sets cookie, returns ok', async () => {
  const db = freshDb();
  seed(db);
  const app = freshApp(db);
  const kid = db.prepare("SELECT id FROM people WHERE name='Gabriel'").get();
  const res = await request(app).post('/api/auth/login').send({ person_id: kid.id });
  assert.equal(res.status, 200);
  assert.ok(res.headers['set-cookie']?.some(c => c.startsWith('tally_session=')));
});

test('POST /api/auth/login as parent requires PIN', async () => {
  const db = freshDb();
  seed(db);
  const app = freshApp(db);
  const parent = db.prepare("SELECT id FROM people WHERE role='parent'").get();

  const wrong = await request(app).post('/api/auth/login').send({ person_id: parent.id, pin: '0000' });
  assert.equal(wrong.status, 401);

  const right = await request(app).post('/api/auth/login').send({ person_id: parent.id, pin: '1234' });
  assert.equal(right.status, 200);
});

test('GET /api/me returns 401 when not logged in, user payload when logged in', async () => {
  const db = freshDb();
  seed(db);
  const app = freshApp(db);
  const agent = request.agent(app);

  const r1 = await agent.get('/api/me');
  assert.equal(r1.status, 401);

  const kid = db.prepare("SELECT id FROM people WHERE name='Gabriel'").get();
  await agent.post('/api/auth/login').send({ person_id: kid.id });

  const r2 = await agent.get('/api/me');
  assert.equal(r2.status, 200);
  assert.equal(r2.body.name, 'Gabriel');
});

test('POST /api/auth/logout clears the session', async () => {
  const db = freshDb();
  seed(db);
  const app = freshApp(db);
  const agent = request.agent(app);
  const kid = db.prepare("SELECT id FROM people WHERE name='Gabriel'").get();
  await agent.post('/api/auth/login').send({ person_id: kid.id });
  await agent.post('/api/auth/logout');
  const r = await agent.get('/api/me');
  assert.equal(r.status, 401);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `/api/auth/*` routes don't exist.

- [ ] **Step 3: Create `src/routes/auth.js`**

```js
import { Router } from 'express';
import { createSession, destroySession, currentUser, verifyParentPin } from '../auth.js';

export function authRoutes() {
  const r = Router();

  r.get('/picker', (req, res) => {
    const db = req.app.get('db');
    const people = db.prepare(`
      SELECT id, name, role, avatar_color
      FROM people
      WHERE role IN ('kid','parent')
      ORDER BY role DESC, name
    `).all();
    res.json({ people });
  });

  r.post('/login', (req, res) => {
    const db = req.app.get('db');
    const { person_id, pin } = req.body || {};
    const person = db.prepare('SELECT * FROM people WHERE id = ?').get(person_id);
    if (!person || person.role === 'wall') {
      return res.status(404).json({ error: 'No such person' });
    }
    if (person.role === 'parent') {
      if (!pin || !verifyParentPin(db, pin)) {
        return res.status(401).json({ error: 'Wrong PIN' });
      }
    }
    const token = createSession(db, person.id, { ua: req.get('user-agent') || '' });
    req.session.token = token;
    res.json({ ok: true, person: { id: person.id, name: person.name, role: person.role } });
  });

  r.post('/logout', (req, res) => {
    const db = req.app.get('db');
    destroySession(db, req.session?.token);
    req.session = null;
    res.json({ ok: true });
  });

  return r;
}

export function meRoute() {
  const r = Router();
  r.get('/me', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    res.json({ id: user.person_id, name: user.name, role: user.role });
  });
  return r;
}
```

- [ ] **Step 4: Wire routes in `src/app.js`**

Modify `src/app.js`, replacing the existing file:

```js
import express from 'express';
import cookieSession from 'cookie-session';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { authRoutes, meRoute } from './routes/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildApp({ db, sessionSecret = 'dev-secret' }) {
  const app = express();
  app.set('db', db);
  app.use(express.json({ limit: '8mb' }));
  app.use(cookieSession({
    name: 'tally_session',
    keys: [sessionSecret],
    maxAge: 365 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    httpOnly: true,
  }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes());
  app.use('/api', meRoute());

  app.use(express.static(join(__dirname, '..', 'public')));

  return app;
}
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/auth.js src/app.js tests/routes-auth.test.js
git commit -m "feat(auth): picker, login (kid + parent PIN), logout, me endpoints"
```

---

## Task 9: Assignment generator — materialize recurring chores for today

**Files:**
- Create: `src/lib/assignments.js`
- Test: `tests/assignments-generator.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/assignments-generator.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { generateForToday } from '../src/lib/assignments.js';
import { today, dayOfWeek } from '../src/lib/dates.js';

function seedKid(db, name = 'Gabriel') {
  return db.prepare(`
    INSERT INTO people (name, role) VALUES (?, 'kid') RETURNING id
  `).get(name).id;
}
function seedChore(db, fields) {
  const cols = Object.keys(fields).join(',');
  const placeholders = Object.keys(fields).map(() => '?').join(',');
  return db.prepare(`INSERT INTO chores (${cols}) VALUES (${placeholders}) RETURNING id`)
    .get(...Object.values(fields)).id;
}

test('daily recurring chore generates one assignment per assignee per day', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const chore = seedChore(db, {
    title: 'Make bed', recurs: 'daily', kind: 'recurring',
    default_assignees: String(kid),
  });
  generateForToday(db);
  const rows = db.prepare('SELECT * FROM assignments WHERE chore_id = ?').all(chore);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].person_id, kid);
  assert.equal(rows[0].due_date, today());
});

test('generator is idempotent — running twice does not duplicate', () => {
  const db = freshDb();
  const kid = seedKid(db);
  seedChore(db, { title: 'Daily X', recurs: 'daily', default_assignees: String(kid) });
  generateForToday(db);
  generateForToday(db);
  const rows = db.prepare('SELECT * FROM assignments').all();
  assert.equal(rows.length, 1);
});

test('weekly chore only generates on listed day of week', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const dow = dayOfWeek(today());
  const otherDay = (dow + 1) % 7;

  const matching = seedChore(db, {
    title: 'Today match', recurs: 'weekly', recurs_days: String(dow),
    default_assignees: String(kid),
  });
  const notMatching = seedChore(db, {
    title: 'Other day', recurs: 'weekly', recurs_days: String(otherDay),
    default_assignees: String(kid),
  });

  generateForToday(db);
  const matched = db.prepare('SELECT * FROM assignments WHERE chore_id = ?').all(matching);
  const skipped = db.prepare('SELECT * FROM assignments WHERE chore_id = ?').all(notMatching);
  assert.equal(matched.length, 1);
  assert.equal(skipped.length, 0);
});

test('soft-deleted chores are skipped', () => {
  const db = freshDb();
  const kid = seedKid(db);
  const id = seedChore(db, { title: 'Gone', recurs: 'daily', default_assignees: String(kid) });
  db.prepare("UPDATE chores SET deleted_at = datetime('now') WHERE id = ?").run(id);
  generateForToday(db);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM assignments').get().c, 0);
});

test('chore with no default_assignees is skipped', () => {
  const db = freshDb();
  seedChore(db, { title: 'Unassigned', recurs: 'daily', default_assignees: '' });
  generateForToday(db);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM assignments').get().c, 0);
});

test('multiple default_assignees creates one assignment per kid', () => {
  const db = freshDb();
  const k1 = seedKid(db, 'Gabriel');
  const k2 = seedKid(db, 'Olivia');
  seedChore(db, { title: 'Both', recurs: 'daily', default_assignees: `${k1},${k2}` });
  generateForToday(db);
  const rows = db.prepare('SELECT * FROM assignments').all();
  assert.equal(rows.length, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `assignments.js` not found.

- [ ] **Step 3: Create `src/lib/assignments.js`**

```js
import { today, dayOfWeek, weekStart, fromIso } from './dates.js';

export function generateForToday(db, date = today()) {
  const dow = dayOfWeek(date);
  const chores = db.prepare(`
    SELECT * FROM chores
    WHERE kind = 'recurring' AND deleted_at IS NULL AND default_assignees != ''
  `).all();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO assignments (chore_id, person_id, due_date, status)
    VALUES (?, ?, ?, 'pending')
  `);

  const tx = db.transaction((rows) => {
    for (const c of rows) {
      if (!shouldRunOn(c, date, dow)) continue;
      const assignees = c.default_assignees.split(',').map(s => parseInt(s, 10)).filter(Boolean);
      for (const personId of assignees) {
        insert.run(c.id, personId, date);
      }
    }
  });
  tx(chores);
}

function shouldRunOn(chore, isoDate, dow) {
  switch (chore.recurs) {
    case 'daily':
      return true;
    case 'weekly': {
      if (!chore.recurs_days) return true;
      const days = chore.recurs_days.split(',').map(Number);
      return days.includes(dow);
    }
    case 'biweekly': {
      if (chore.recurs_days) {
        const days = chore.recurs_days.split(',').map(Number);
        if (!days.includes(dow)) return false;
      }
      const anchor = chore.recurs_anchor || isoDate;
      const weeks = Math.floor((fromIso(isoDate) - fromIso(weekStart(anchor))) / (1000 * 60 * 60 * 24 * 7));
      return weeks % 2 === 0;
    }
    case 'monthly':
      return fromIso(isoDate).getDate() === fromIso(chore.recurs_anchor || isoDate).getDate();
    default:
      return false;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS (all six generator tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/assignments.js tests/assignments-generator.test.js
git commit -m "feat(assignments): generator materializes recurring chores per day"
```

---

## Task 10: Hook generator into the server boot + hourly cron

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Update `server.js` to run the generator on boot and hourly**

```js
import { openDb } from './src/db.js';
import { buildApp } from './src/app.js';
import { generateForToday } from './src/lib/assignments.js';

const PORT = process.env.PORT || 3007;
const SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';

const db = openDb('./tally.db');
const app = buildApp({ db, sessionSecret: SECRET });

generateForToday(db);
setInterval(() => {
  try { generateForToday(db); }
  catch (e) { console.error('generator failed:', e); }
}, 60 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Tally listening on http://localhost:${PORT}`);
});
```

- [ ] **Step 2: Smoke test the boot manually**

Run: `npm run dev`
Expected: server logs `Tally listening on http://localhost:3007` and does not crash.
Stop with Ctrl-C.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(server): run assignment generator on boot + hourly"
```

---

## Task 11: Kid home API (`GET /api/home`, `POST /api/assignments/:id/done`)

**Files:**
- Create: `src/routes/home.js`
- Modify: `src/app.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/routes-home.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';
import { generateForToday } from '../src/lib/assignments.js';
import { today } from '../src/lib/dates.js';

function setup() {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role, weekly_target_pts) VALUES ('Gabriel','kid',150) RETURNING id").get().id;
  const choreId = db.prepare(`
    INSERT INTO chores (title, points, recurs, default_assignees, anti_cheat)
    VALUES ('Make bed', 5, 'daily', ?, 'honor') RETURNING id
  `).get(String(kid)).id;
  generateForToday(db);
  return { db, kid, choreId, app: freshApp(db) };
}

async function loginAs(app, personId) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: personId });
  return agent;
}

test('GET /api/home returns today\'s + overdue assignments for the kid', async () => {
  const { app, kid } = setup();
  const agent = await loginAs(app, kid);
  const res = await agent.get('/api/home');
  assert.equal(res.status, 200);
  assert.equal(res.body.person.name, 'Gabriel');
  assert.equal(res.body.today.length, 1);
  assert.equal(res.body.today[0].title, 'Make bed');
  assert.equal(res.body.today[0].status, 'pending');
});

test('POST /api/assignments/:id/done flips status to done', async () => {
  const { app, kid, db } = setup();
  const agent = await loginAs(app, kid);
  const a = db.prepare("SELECT id FROM assignments WHERE person_id = ?").get(kid);
  const res = await agent.post(`/api/assignments/${a.id}/done`);
  assert.equal(res.status, 200);
  const after = db.prepare('SELECT status FROM assignments WHERE id = ?').get(a.id);
  assert.equal(after.status, 'done');
});

test('cannot mark someone else\'s assignment done', async () => {
  const { app, db } = setup();
  const other = db.prepare("INSERT INTO people (name, role) VALUES ('Olivia','kid') RETURNING id").get().id;
  const agent = await loginAs(app, other);
  const a = db.prepare("SELECT id FROM assignments").get();
  const res = await agent.post(`/api/assignments/${a.id}/done`);
  assert.equal(res.status, 403);
});

test('GET /api/home rejects unauthenticated requests', async () => {
  const { app } = setup();
  const res = await request(app).get('/api/home');
  assert.equal(res.status, 401);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — routes don't exist yet.

- [ ] **Step 3: Create `src/routes/home.js`**

```js
import { Router } from 'express';
import { requireRole, requireAnyAuth } from '../auth.js';
import { today, isOverdue } from '../lib/dates.js';

export function homeRoutes() {
  const r = Router();

  r.get('/home', requireRole('kid'), (req, res) => {
    const db = req.app.get('db');
    const personId = req.user.person_id;
    const person = db.prepare(`
      SELECT id, name, avatar_color, weekly_target_pts, base_pay_cents, bonus_rate_cents,
             bank_cents, streak_days
      FROM people WHERE id = ?
    `).get(personId);

    const assignments = db.prepare(`
      SELECT a.id, a.due_date, a.status, a.note, c.title, c.points, c.anti_cheat
      FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      WHERE a.person_id = ?
        AND (a.due_date = ? OR (a.due_date < ? AND a.status NOT IN ('done','expired','rejected')))
      ORDER BY a.due_date, c.title
    `).all(personId, today(), today());

    const todayList = assignments.filter(a => a.due_date === today());
    const overdueList = assignments.filter(a => a.due_date !== today());

    res.json({
      person,
      today: todayList,
      overdue: overdueList,
    });
  });

  r.post('/assignments/:id/done', requireAnyAuth, (req, res) => {
    const db = req.app.get('db');
    const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.person_id !== req.user.person_id && req.user.role !== 'parent') {
      return res.status(403).json({ error: 'Not your assignment' });
    }
    const chore = db.prepare('SELECT anti_cheat FROM chores WHERE id = ?').get(a.chore_id);
    if (chore.anti_cheat !== 'honor') {
      return res.status(400).json({ error: 'Use /submit for photo/approval chores' });
    }
    db.prepare(`
      UPDATE assignments
      SET status = 'done', updated_at = datetime('now'), late = CASE WHEN due_date < date('now') THEN 1 ELSE 0 END
      WHERE id = ?
    `).run(req.params.id);
    res.json({ ok: true });
  });

  return r;
}
```

- [ ] **Step 4: Wire routes in `src/app.js`**

Add the import and `app.use(...)` to `src/app.js`. Final file:

```js
import express from 'express';
import cookieSession from 'cookie-session';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { authRoutes, meRoute } from './routes/auth.js';
import { homeRoutes } from './routes/home.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildApp({ db, sessionSecret = 'dev-secret' }) {
  const app = express();
  app.set('db', db);
  app.use(express.json({ limit: '8mb' }));
  app.use(cookieSession({
    name: 'tally_session',
    keys: [sessionSecret],
    maxAge: 365 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    httpOnly: true,
  }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes());
  app.use('/api', meRoute());
  app.use('/api', homeRoutes());

  app.use(express.static(join(__dirname, '..', 'public')));

  return app;
}
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/home.js src/app.js tests/routes-home.test.js
git commit -m "feat(home): GET /api/home and POST /api/assignments/:id/done"
```

---

## Task 12: Wall API (`GET /api/wall`)

**Files:**
- Create: `src/routes/wall.js`
- Modify: `src/app.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/routes-wall.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';
import { generateForToday } from '../src/lib/assignments.js';

test('GET /api/wall returns roster + today/overdue assignments (no auth)', async () => {
  const db = freshDb();
  const gabriel = db.prepare("INSERT INTO people (name, role) VALUES ('Gabriel','kid') RETURNING id").get().id;
  const olivia = db.prepare("INSERT INTO people (name, role) VALUES ('Olivia','kid') RETURNING id").get().id;
  db.prepare(`INSERT INTO chores (title, points, recurs, default_assignees) VALUES ('Bed', 5, 'daily', ?)`).run(`${gabriel},${olivia}`);
  generateForToday(db);

  const res = await request(freshApp(db)).get('/api/wall');
  assert.equal(res.status, 200);
  assert.equal(res.body.kids.length, 2);
  const g = res.body.kids.find(k => k.name === 'Gabriel');
  assert.equal(g.today.length, 1);
  assert.equal(g.today[0].title, 'Bed');
  assert.equal(typeof res.body.house_pct, 'number');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Create `src/routes/wall.js`**

```js
import { Router } from 'express';
import { today } from '../lib/dates.js';

export function wallRoutes() {
  const r = Router();

  r.get('/wall', (req, res) => {
    const db = req.app.get('db');
    const kids = db.prepare(`
      SELECT id, name, avatar_color, weekly_target_pts, streak_days
      FROM people WHERE role = 'kid' ORDER BY id
    `).all();

    const todayIso = today();
    const assignmentRows = db.prepare(`
      SELECT a.id, a.person_id, a.due_date, a.status,
             c.title, c.points
      FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      WHERE a.person_id IN (${kids.map(() => '?').join(',') || 'NULL'})
        AND (a.due_date = ? OR (a.due_date < ? AND a.status NOT IN ('done','expired','rejected')))
      ORDER BY a.due_date, c.title
    `).all(...kids.map(k => k.id), todayIso, todayIso);

    let total = 0, done = 0;
    for (const kid of kids) {
      kid.today = [];
      kid.overdue = [];
    }
    for (const a of assignmentRows) {
      const kid = kids.find(k => k.id === a.person_id);
      if (!kid) continue;
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

- [ ] **Step 4: Wire in `src/app.js`**

Add `import { wallRoutes } from './routes/wall.js';` and `app.use('/api', wallRoutes());` to the route registrations.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/wall.js src/app.js tests/routes-wall.test.js
git commit -m "feat(wall): GET /api/wall returns roster + assignments"
```

---

## Task 13: Admin — People CRUD

**Files:**
- Create: `src/routes/admin/people.js`
- Modify: `src/app.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/routes-admin-people.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';

async function asParent(app, db) {
  const id = db.prepare("INSERT INTO people (name, role) VALUES ('Mom','parent') RETURNING id").get().id;
  const agent = request.agent(app);
  const r = await agent.post('/api/auth/login').send({ person_id: id, pin: '1234' });
  if (r.status !== 200) throw new Error('parent login failed');
  return agent;
}

test('admin people: list, create, patch (parent only)', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const agent = await asParent(app, db);

  const list1 = await agent.get('/api/admin/people');
  assert.equal(list1.status, 200);
  assert.equal(list1.body.people.length, 1); // just the parent

  const created = await agent.post('/api/admin/people').send({
    name: 'Gabriel', role: 'kid', dob: '2011-01-25',
    weekly_target_pts: 150, base_pay_cents: 1000, bonus_rate_cents: 10,
    avatar_color: '#22C55E',
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.person.name, 'Gabriel');
  assert.equal(created.body.person.weekly_target_pts, 150);

  const patched = await agent.patch(`/api/admin/people/${created.body.person.id}`)
    .send({ weekly_target_pts: 200 });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.person.weekly_target_pts, 200);
});

test('admin people rejects non-parent', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: kid });
  const r = await agent.get('/api/admin/people');
  assert.equal(r.status, 403);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Create `src/routes/admin/people.js`**

```js
import { Router } from 'express';
import { requireRole } from '../../auth.js';

const ALLOWED_FIELDS = [
  'name', 'dob', 'role', 'avatar_color',
  'weekly_target_pts', 'base_pay_cents', 'bonus_rate_cents',
  'freeze_start', 'freeze_end',
];

export function adminPeopleRoutes() {
  const r = Router();
  r.use(requireRole('parent'));

  r.get('/people', (req, res) => {
    const db = req.app.get('db');
    const people = db.prepare(`
      SELECT * FROM people WHERE role IN ('kid','parent') ORDER BY role DESC, name
    `).all();
    res.json({ people });
  });

  r.post('/people', (req, res) => {
    const db = req.app.get('db');
    const data = pickFields(req.body || {});
    if (!data.name || !data.role) return res.status(400).json({ error: 'name and role required' });
    if (!['kid','parent'].includes(data.role)) return res.status(400).json({ error: 'invalid role' });
    const cols = Object.keys(data);
    const stmt = db.prepare(`
      INSERT INTO people (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) RETURNING *
    `);
    const person = stmt.get(...cols.map(c => data[c]));
    res.json({ person });
  });

  r.patch('/people/:id', (req, res) => {
    const db = req.app.get('db');
    const data = pickFields(req.body || {});
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'nothing to update' });
    const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
    const person = db.prepare(`
      UPDATE people SET ${sets} WHERE id = ? RETURNING *
    `).get(...Object.values(data), req.params.id);
    if (!person) return res.status(404).json({ error: 'Not found' });
    res.json({ person });
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

- [ ] **Step 4: Wire in `src/app.js`**

Add `import { adminPeopleRoutes } from './routes/admin/people.js';` and `app.use('/api/admin', adminPeopleRoutes());`.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin/people.js src/app.js tests/routes-admin-people.test.js
git commit -m "feat(admin): people list/create/patch (parent only)"
```

---

## Task 14: Admin — Chores CRUD

**Files:**
- Create: `src/routes/admin/chores.js`
- Modify: `src/app.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/routes-admin-chores.test.js`:

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

test('admin chores: full CRUD', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const agent = await asParent(app, db);

  const list1 = await agent.get('/api/admin/chores');
  assert.equal(list1.status, 200);
  assert.equal(list1.body.chores.length, 0);

  const c = await agent.post('/api/admin/chores').send({
    title: 'Make bed', points: 5, recurs: 'daily', anti_cheat: 'honor',
  });
  assert.equal(c.status, 200);
  const id = c.body.chore.id;

  const patched = await agent.patch(`/api/admin/chores/${id}`).send({ points: 10 });
  assert.equal(patched.body.chore.points, 10);

  const del = await agent.delete(`/api/admin/chores/${id}`);
  assert.equal(del.status, 200);

  // Deleted chores hidden from list by default
  const list2 = await agent.get('/api/admin/chores');
  assert.equal(list2.body.chores.length, 0);

  // But still in DB (soft-delete)
  const row = db.prepare('SELECT deleted_at FROM chores WHERE id = ?').get(id);
  assert.ok(row.deleted_at);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Create `src/routes/admin/chores.js`**

```js
import { Router } from 'express';
import { requireRole } from '../../auth.js';

const ALLOWED_FIELDS = [
  'title', 'description', 'points', 'kind',
  'recurs', 'recurs_days', 'recurs_anchor', 'due_time',
  'anti_cheat', 'late_tax_pct', 'photo_prompt', 'default_assignees',
];

export function adminChoresRoutes() {
  const r = Router();
  r.use(requireRole('parent'));

  r.get('/chores', (req, res) => {
    const db = req.app.get('db');
    const chores = db.prepare(`
      SELECT * FROM chores WHERE deleted_at IS NULL ORDER BY title
    `).all();
    res.json({ chores });
  });

  r.post('/chores', (req, res) => {
    const db = req.app.get('db');
    const data = pickFields(req.body || {});
    if (!data.title) return res.status(400).json({ error: 'title required' });
    const cols = Object.keys(data);
    const chore = db.prepare(`
      INSERT INTO chores (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) RETURNING *
    `).get(...cols.map(c => data[c]));
    res.json({ chore });
  });

  r.patch('/chores/:id', (req, res) => {
    const db = req.app.get('db');
    const data = pickFields(req.body || {});
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'nothing to update' });
    const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
    const chore = db.prepare(`
      UPDATE chores SET ${sets} WHERE id = ? RETURNING *
    `).get(...Object.values(data), req.params.id);
    if (!chore) return res.status(404).json({ error: 'Not found' });
    res.json({ chore });
  });

  r.delete('/chores/:id', (req, res) => {
    const db = req.app.get('db');
    const r2 = db.prepare(`
      UPDATE chores SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL
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

- [ ] **Step 4: Wire in `src/app.js`**

Add `import { adminChoresRoutes } from './routes/admin/chores.js';` and `app.use('/api/admin', adminChoresRoutes());`.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin/chores.js src/app.js tests/routes-admin-chores.test.js
git commit -m "feat(admin): chores CRUD with soft delete"
```

---

## Task 15: Admin — Today dashboard endpoint

**Files:**
- Create: `src/routes/admin/today.js`
- Modify: `src/app.js`

- [ ] **Step 1: Write the failing test**

Create `tests/routes-admin-today.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';
import { generateForToday } from '../src/lib/assignments.js';

async function asParent(app, db) {
  const id = db.prepare("INSERT INTO people (name, role) VALUES ('Mom','parent') RETURNING id").get().id;
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id, pin: '1234' });
  return agent;
}

test('GET /api/admin/today returns counts and a per-kid summary', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('Gabriel','kid') RETURNING id").get().id;
  db.prepare(`INSERT INTO chores (title, points, recurs, default_assignees) VALUES ('Bed',5,'daily',?)`).run(String(kid));
  generateForToday(db);

  const app = freshApp(db);
  const agent = await asParent(app, db);
  const res = await agent.get('/api/admin/today');
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.house_pct === 'number');
  assert.equal(res.body.kids.length, 1);
  assert.equal(res.body.kids[0].today_total, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Create `src/routes/admin/today.js`**

```js
import { Router } from 'express';
import { requireRole } from '../../auth.js';
import { today } from '../../lib/dates.js';

export function adminTodayRoutes() {
  const r = Router();
  r.use(requireRole('parent'));

  r.get('/today', (req, res) => {
    const db = req.app.get('db');
    const t = today();
    const kids = db.prepare(`
      SELECT id, name, avatar_color FROM people WHERE role = 'kid' ORDER BY name
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
    }
    res.json({
      house_pct: total === 0 ? 100 : Math.round((done / total) * 100),
      kids, total, done, today: t,
    });
  });

  return r;
}
```

- [ ] **Step 4: Wire in `src/app.js`**

Add `import { adminTodayRoutes } from './routes/admin/today.js';` and `app.use('/api/admin', adminTodayRoutes());`.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin/today.js src/app.js tests/routes-admin-today.test.js
git commit -m "feat(admin): today dashboard endpoint"
```

---

## Task 16: Frontend foundation — design tokens, base CSS, font loading

**Files:**
- Create: `public/css/tokens.css`, `public/css/base.css`, `public/css/components.css`, `public/css/layouts.css`

- [ ] **Step 1: Create `public/css/tokens.css`**

```css
:root {
  /* Type */
  --font-ui: 'Inter', system-ui, sans-serif;
  --font-num: 'JetBrains Mono', ui-monospace, monospace;

  /* Light palette (default) */
  --bg: #FCFCFD;
  --card: #FFFFFF;
  --card-muted: #F8FAFC;
  --ink: #0F172A;
  --muted: #64748B;
  --border: #E2E8F0;

  --green: #10B981;
  --red: #B91C1C;
  --amber: #D97706;
  --purple-1: #6366F1;
  --purple-2: #8B5CF6;

  /* The signature hero gradient (constant across themes) */
  --hero-bg-1: #0F172A;
  --hero-bg-2: #1E293B;
  --hero-glow: rgba(99, 102, 241, 0.4);
  --hero-ink: #FFFFFF;
  --hero-muted: #94A3B8;

  /* Spacing scale */
  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px; --s7: 48px;

  --r-sm: 6px; --r-md: 10px; --r-lg: 14px; --r-xl: 20px;

  --shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.04);
  --shadow-md: 0 4px 12px rgba(15, 23, 42, 0.08);
  --shadow-lg: 0 20px 50px rgba(15, 23, 42, 0.18);
}

[data-theme="dark"] {
  --bg: #0A0A0A;
  --card: #171717;
  --card-muted: #0F0F0F;
  --ink: #E5E5E5;
  --muted: #737373;
  --border: #262626;
  --green: #22C55E;
  --red: #F87171;
}
```

- [ ] **Step 2: Create `public/css/base.css`**

```css
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

html, body {
  height: 100%;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font-ui);
  font-feature-settings: 'cv11', 'ss01';
  -webkit-font-smoothing: antialiased;
}

button, input, select, textarea {
  font: inherit;
  color: inherit;
}

a { color: inherit; text-decoration: none; }

.num { font-family: var(--font-num); font-feature-settings: 'tnum'; }

.muted { color: var(--muted); }
.green { color: var(--green); }
.red { color: var(--red); }
.label {
  font-size: 0.62rem;
  letter-spacing: 1.4px;
  text-transform: uppercase;
  font-weight: 600;
  color: var(--muted);
}

/* Hidden but accessible */
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
}
```

- [ ] **Step 3: Create `public/css/components.css`**

```css
/* ───── Buttons ───── */
.btn {
  display: inline-flex; align-items: center; gap: var(--s2);
  padding: 10px 16px;
  border-radius: var(--r-md);
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--ink);
  font-weight: 500;
  cursor: pointer;
  transition: transform 0.08s ease, box-shadow 0.12s ease, background 0.12s;
}
.btn:hover { transform: translateY(-1px); box-shadow: var(--shadow-sm); }
.btn-primary { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.btn-danger  { background: #FEE2E2; color: var(--red); border-color: #FECACA; }
.btn-ghost   { background: transparent; }

/* ───── Card ───── */
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-sm);
  padding: var(--s4);
}

/* ───── Hero card (the signature) ───── */
.hero {
  background: linear-gradient(135deg, var(--hero-bg-1), var(--hero-bg-2));
  color: var(--hero-ink);
  border-radius: var(--r-xl);
  padding: var(--s5);
  position: relative;
  overflow: hidden;
}
.hero::after {
  content: '';
  position: absolute; right: -60px; top: -60px;
  width: 200px; height: 200px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--hero-glow) 0%, transparent 70%);
}
.hero .label { color: var(--hero-muted); }
.hero .big-num {
  font-family: var(--font-num);
  font-size: 2.6rem;
  font-weight: 600;
  letter-spacing: -1.5px;
  line-height: 1;
  margin-top: var(--s2);
}
.hero .big-num .denom { font-size: 1rem; color: var(--hero-muted); }
.hero .bar { height: 6px; background: rgba(255,255,255,0.12); border-radius: 99px; margin-top: var(--s3); overflow: hidden; }
.hero .bar-fill { height: 100%; background: linear-gradient(90deg, var(--purple-1), var(--purple-2)); border-radius: 99px; }

/* ───── Transaction row (for chores) ───── */
.txn {
  display: flex; align-items: center; justify-content: space-between;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  padding: 10px 12px;
  box-shadow: var(--shadow-sm);
  font-size: 0.92rem;
}
.txn .left { display: flex; gap: var(--s2); align-items: center; }
.txn .ico {
  width: 30px; height: 30px;
  border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  font-size: 0.78rem; font-weight: 700;
  background: #EEF2FF; color: var(--purple-1);
}
.txn .ico.cam   { background: #FEF3C7; color: #92400E; }
.txn .ico.appr  { background: #EDE9FE; color: #5B21B6; }
.txn .ico.over  { background: #FEE2E2; color: var(--red); }
.txn .ico.done  { background: #D1FAE5; color: #047857; }
.txn .pts { font-family: var(--font-num); font-weight: 600; color: var(--green); }
.txn.done { background: var(--card-muted); color: var(--muted); }
.txn.done .pts { color: var(--muted); text-decoration: line-through; }
.txn.over { border-color: #FCA5A5; background: #FEF2F2; }

/* ───── Avatar ───── */
.av {
  width: 34px; height: 34px; border-radius: 50%;
  background: var(--ink); color: var(--bg);
  display: flex; align-items: center; justify-content: center;
  font-weight: 600;
}
.av.lg { width: 56px; height: 56px; font-size: 1.4rem; }
```

- [ ] **Step 4: Create `public/css/layouts.css`** (stub — populated by later tasks)

```css
.page { max-width: 480px; margin: 0 auto; padding: var(--s5) var(--s4); }
.page.wide { max-width: 1100px; }
.page header.app-header { display:flex; justify-content:space-between; align-items:center; margin-bottom: var(--s5); }
.page header.app-header h1 { font-size: 1.4rem; letter-spacing: -0.5px; }

.stack { display: flex; flex-direction: column; gap: var(--s3); }
.row   { display: flex; gap: var(--s3); align-items: center; }
.spaced { justify-content: space-between; }
```

- [ ] **Step 5: Commit**

```bash
git add public/css/
git commit -m "feat(css): design tokens, base, components, layouts"
```

---

## Task 17: Frontend foundation — `index.html` shell + PWA stubs

**Files:**
- Create: `public/index.html`, `public/manifest.json`, `public/sw.js`

- [ ] **Step 1: Create `public/manifest.json`**

```json
{
  "name": "Tally",
  "short_name": "Tally",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#FCFCFD",
  "theme_color": "#0F172A",
  "icons": [
    { "src": "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='20' fill='%230F172A'/%3E%3Ctext x='50' y='66' text-anchor='middle' fill='white' font-family='monospace' font-size='42' font-weight='700'%3ET%3C/text%3E%3C/svg%3E", "sizes": "192x192", "type": "image/svg+xml" }
  ]
}
```

- [ ] **Step 2: Create `public/sw.js`** (minimal — caching grows in later phases)

```js
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // no-op for now
```

- [ ] **Step 3: Create `public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#0F172A" />
  <title>Tally</title>
  <link rel="manifest" href="/manifest.json" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/css/tokens.css" />
  <link rel="stylesheet" href="/css/base.css" />
  <link rel="stylesheet" href="/css/components.css" />
  <link rel="stylesheet" href="/css/layouts.css" />
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/js/app.js"></script>
  <script>
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
    const saved = localStorage.getItem('tally_theme');
    if (saved === 'dark' || (saved !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  </script>
</body>
</html>
```

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/manifest.json public/sw.js
git commit -m "feat(pwa): index.html shell, manifest, sw stub"
```

---

## Task 18: Frontend — API + DOM helpers + router

**Files:**
- Create: `public/js/lib/api.js`, `public/js/lib/dom.js`, `public/js/app.js`

- [ ] **Step 1: Create `public/js/lib/dom.js`**

```js
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === false || v == null) continue;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
```

- [ ] **Step 2: Create `public/js/lib/api.js`**

```js
async function req(method, path, body) {
  const opts = {
    method,
    credentials: 'same-origin',
    headers: { 'accept': 'application/json' },
  };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

export const api = {
  get:    (p) => req('GET', p),
  post:   (p, b) => req('POST', p, b),
  patch:  (p, b) => req('PATCH', p, b),
  del:    (p) => req('DELETE', p),
};
```

- [ ] **Step 3: Create `public/js/app.js`**

```js
import { api } from './lib/api.js';
import { $, clear } from './lib/dom.js';
import { renderPicker } from './pages/picker.js';
import { renderHome } from './pages/home.js';
import { renderAdmin } from './pages/admin.js';

const app = $('#app');

const routes = [
  { path: /^\/$/, render: routeRoot },
  { path: /^\/admin/, render: () => renderAdmin(app) },
];

async function routeRoot() {
  try {
    const me = await api.get('/api/me');
    if (me.role === 'kid') return renderHome(app);
    if (me.role === 'parent') return renderAdmin(app);
  } catch (e) {
    if (e.status === 401) return renderPicker(app);
    throw e;
  }
}

async function navigate(path = location.pathname) {
  for (const r of routes) {
    if (r.path.test(path)) { clear(app); await r.render(); return; }
  }
  clear(app);
  app.appendChild(document.createTextNode('Not found'));
}

window.addEventListener('popstate', () => navigate());
window.tallyNavigate = (path) => { history.pushState({}, '', path); navigate(); };

navigate();
```

- [ ] **Step 4: Commit**

```bash
git add public/js/lib/api.js public/js/lib/dom.js public/js/app.js
git commit -m "feat(spa): api + dom helpers, top-level router"
```

---

## Task 19: Frontend — Picker page

**Files:**
- Create: `public/js/pages/picker.js`

- [ ] **Step 1: Create `public/js/pages/picker.js`**

```js
import { api } from '../lib/api.js';
import { el, clear } from '../lib/dom.js';

export async function renderPicker(root) {
  clear(root);
  const { people } = await api.get('/api/auth/picker');

  const grid = el('div', { class: 'picker-grid' },
    people.map(p => el('button', {
      class: 'picker-tile',
      onClick: () => onPick(p, root),
    }, [
      el('div', { class: 'av lg', style: { background: p.avatar_color } }, [p.name[0].toUpperCase()]),
      el('div', { class: 'picker-name' }, [p.name]),
      el('div', { class: 'label' }, [p.role]),
    ]))
  );

  root.appendChild(el('div', { class: 'page' }, [
    el('header', { class: 'app-header' }, [
      el('h1', {}, ['Tally']),
    ]),
    el('p', { class: 'muted', style: { marginBottom: '24px' } }, ['Who\'s using this device?']),
    grid,
  ]));
}

async function onPick(person, root) {
  if (person.role === 'parent') return promptForPin(person, root);
  try {
    await api.post('/api/auth/login', { person_id: person.id });
    window.tallyNavigate('/');
  } catch (e) {
    alert('Login failed: ' + e.message);
  }
}

function promptForPin(person, root) {
  const pin = prompt(`Parent PIN for ${person.name}:`);
  if (!pin) return;
  api.post('/api/auth/login', { person_id: person.id, pin })
    .then(() => window.tallyNavigate('/'))
    .catch(e => alert('Wrong PIN: ' + e.message));
}
```

- [ ] **Step 2: Append picker styles to `public/css/layouts.css`**

```css
.picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: var(--s3);
}
.picker-tile {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  padding: var(--s4);
  display: flex; flex-direction: column; align-items: center; gap: var(--s2);
  cursor: pointer;
  transition: transform 0.08s, box-shadow 0.12s;
}
.picker-tile:hover { transform: translateY(-2px); box-shadow: var(--shadow-md); }
.picker-name { font-weight: 600; font-size: 1.05rem; }
```

- [ ] **Step 3: Manual smoke test**

Run: `npm run dev`. Open http://localhost:3007. You should see the picker with the seeded "Wall" person (we'll exclude that next).

Update `src/routes/auth.js` to filter out wall: the existing query already does this (`WHERE role IN ('kid','parent')`), so the wall identity is hidden from the picker. If you see only "Wall," create a kid manually via API:

```bash
# Log in as parent first (via picker), then in browser console:
fetch('/api/admin/people', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({name:'Gabriel', role:'kid', avatar_color:'#22C55E'})});
```

You may need to seed a parent person first too. Add this temporary one-time seed via a Node REPL:

```bash
node -e "
import('./src/db.js').then(async ({openDb})=>{
  const db = openDb('./tally.db');
  db.prepare(\"INSERT INTO people (name, role, avatar_color) VALUES ('Mom','parent','#0F172A')\").run();
  console.log('seeded parent');
});
"
```

Then refresh — picker shows the parent. Pick the parent → prompt PIN `1234` → logged in (you'll see blank page since admin isn't rendered yet, that's the next task).

- [ ] **Step 4: Commit**

```bash
git add public/js/pages/picker.js public/css/layouts.css
git commit -m "feat(spa): profile picker page"
```

---

## Task 20: Frontend — Kid home page

**Files:**
- Create: `public/js/pages/home.js`

- [ ] **Step 1: Create `public/js/pages/home.js`**

```js
import { api } from '../lib/api.js';
import { el, clear } from '../lib/dom.js';

export async function renderHome(root) {
  clear(root);
  const data = await api.get('/api/home');
  const p = data.person;

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

  const todaySection = el('section', { class: 'stack' }, [
    el('div', { class: 'label' }, ['Today']),
    ...(data.today.length === 0
      ? [el('p', { class: 'muted' }, ['Nothing left today.'])]
      : data.today.map(a => renderTask(a, root))),
  ]);

  const overdueSection = data.overdue.length === 0 ? null : el('section', { class: 'stack' }, [
    el('div', { class: 'label' }, ['Overdue']),
    ...data.overdue.map(a => renderTask(a, root, true)),
  ]);

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
}

function renderTask(a, root, overdue = false) {
  const classes = ['txn'];
  if (a.status === 'done') classes.push('done');
  if (overdue) classes.push('over');

  const ico = a.anti_cheat === 'photo' ? 'cam' : a.anti_cheat === 'approval' ? 'appr' : (a.status === 'done' ? 'done' : '');
  const icoText = a.anti_cheat === 'photo' ? 'P' : a.anti_cheat === 'approval' ? 'A' : (a.status === 'done' ? '✓' : a.title[0]);

  const row = el('div', { class: classes.join(' ') }, [
    el('div', { class: 'left' }, [
      el('div', { class: `ico ${ico}` }, [icoText]),
      el('span', {}, [a.title]),
    ]),
    el('span', { class: 'pts' }, [`+${a.points}`]),
  ]);

  if (a.status !== 'done' && a.anti_cheat === 'honor') {
    row.style.cursor = 'pointer';
    row.addEventListener('click', async () => {
      try {
        await api.post(`/api/assignments/${a.id}/done`);
        renderHome(root);
      } catch (e) {
        alert('Could not mark done: ' + e.message);
      }
    });
  }
  return row;
}

async function logout() {
  await api.post('/api/auth/logout');
  window.tallyNavigate('/');
}
```

- [ ] **Step 2: Manual smoke test**

Run: `npm run dev`. With a kid + a daily chore assigned, log in as the kid via the picker. Verify:
- Hero card shows `0 / 150 pts` (or whatever the target is)
- Today shows the chore with `+5`
- Tap the row → it strikes through and becomes the done state
- Refresh — still done

- [ ] **Step 3: Commit**

```bash
git add public/js/pages/home.js
git commit -m "feat(spa): kid home page with mark-done"
```

---

## Task 21: Frontend — Admin page (tabs + Today + People + Chores)

**Files:**
- Create: `public/js/pages/admin.js`
- Modify: `public/css/layouts.css`

- [ ] **Step 1: Append admin styles to `public/css/layouts.css`**

```css
.admin-tabs {
  display: flex; gap: var(--s2); border-bottom: 1px solid var(--border); margin-bottom: var(--s4);
  overflow-x: auto;
}
.admin-tab {
  padding: 10px 14px;
  background: none; border: none;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  white-space: nowrap;
}
.admin-tab.active { color: var(--ink); border-bottom-color: var(--ink); }

.list-row {
  display: grid; grid-template-columns: 1fr auto;
  align-items: center;
  padding: 12px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  margin-bottom: var(--s2);
}

.form-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: var(--s3); }
.form-field label { font-size: 0.78rem; color: var(--muted); font-weight: 500; }
.form-field input, .form-field select, .form-field textarea {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--card);
}

.modal-backdrop {
  position: fixed; inset: 0;
  background: rgba(15, 23, 42, 0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 100;
}
.modal {
  background: var(--card);
  border-radius: var(--r-xl);
  padding: var(--s5);
  max-width: 460px; width: 92%;
  max-height: 90vh; overflow-y: auto;
}
```

- [ ] **Step 2: Create `public/js/pages/admin.js`**

```js
import { api } from '../lib/api.js';
import { el, clear } from '../lib/dom.js';

const TABS = [
  { key: 'today',  label: 'Today',  render: renderToday },
  { key: 'people', label: 'People', render: renderPeople },
  { key: 'chores', label: 'Chores', render: renderChores },
];

export async function renderAdmin(root) {
  clear(root);
  const me = await api.get('/api/me').catch(() => null);
  if (!me || me.role !== 'parent') { window.tallyNavigate('/'); return; }

  let active = location.hash.replace('#','') || 'today';
  if (!TABS.find(t => t.key === active)) active = 'today';

  const tabsBar = el('nav', { class: 'admin-tabs' },
    TABS.map(t => el('button', {
      class: 'admin-tab' + (t.key === active ? ' active' : ''),
      onClick: () => { location.hash = '#' + t.key; renderAdmin(root); },
    }, [t.label]))
  );

  const content = el('div', {});

  root.appendChild(el('div', { class: 'page wide stack' }, [
    el('header', { class: 'app-header' }, [
      el('h1', {}, ['Tally · Admin']),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn btn-ghost', onClick: () => logout() }, ['Sign out']),
      ]),
    ]),
    tabsBar,
    content,
  ]));

  await TABS.find(t => t.key === active).render(content);
}

async function logout() {
  await api.post('/api/auth/logout');
  window.tallyNavigate('/');
}

/* ───── Today tab ───── */
async function renderToday(host) {
  clear(host);
  const d = await api.get('/api/admin/today');
  host.appendChild(el('div', { class: 'hero' }, [
    el('div', { class: 'label' }, ['House progress today']),
    el('div', { class: 'big-num' }, [String(d.house_pct), el('span', { class: 'denom' }, ['%'])]),
    el('div', { style: { marginTop: '10px', color: 'var(--hero-muted)', fontSize: '0.85rem' } }, [
      `${d.done} of ${d.total} chores done across the family`
    ]),
  ]));
  host.appendChild(el('div', { class: 'stack', style: { marginTop: 'var(--s4)' } },
    d.kids.map(k => el('div', { class: 'list-row' }, [
      el('div', { class: 'row' }, [
        el('div', { class: 'av', style: { background: k.avatar_color } }, [k.name[0]]),
        el('div', {}, [
          el('div', { style: { fontWeight: 600 } }, [k.name]),
          el('div', { class: 'muted', style: { fontSize: '0.82rem' } }, [
            `${k.today_done}/${k.today_total} today` + (k.overdue ? ` · ${k.overdue} overdue` : ''),
          ]),
        ]),
      ]),
      el('span', { class: 'num pts' }, [`${k.today_total === 0 ? 100 : Math.round(k.today_done / k.today_total * 100)}%`]),
    ]))
  ));
}

/* ───── People tab ───── */
async function renderPeople(host) {
  clear(host);
  const { people } = await api.get('/api/admin/people');
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
  host.appendChild(el('div', { class: 'row spaced', style: { marginBottom: 'var(--s3)' } }, [
    el('h3', {}, ['People']),
    el('button', { class: 'btn btn-primary', onClick: () => editPerson(null, host) }, ['+ Add']),
  ]));
  host.appendChild(el('div', { class: 'stack' }, rows));
}

function editPerson(person, host) {
  const isNew = !person;
  const data = person ? { ...person } : { role: 'kid', avatar_color: '#22C55E' };

  const fields = [
    ['name', 'Name', 'text'],
    ['role', 'Role', 'select', ['kid', 'parent']],
    ['dob', 'Date of birth', 'date'],
    ['avatar_color', 'Avatar color (hex)', 'text'],
    ['weekly_target_pts', 'Weekly target (pts)', 'number'],
    ['base_pay_cents', 'Base pay (cents)', 'number'],
    ['bonus_rate_cents', 'Bonus rate (cents/pt)', 'number'],
  ];

  const inputs = fields.map(([key, label, type, opts]) => {
    const id = `f_${key}`;
    let input;
    if (type === 'select') {
      input = el('select', { id, onChange: e => data[key] = e.target.value },
        opts.map(o => el('option', { value: o, selected: data[key] === o }, [o])));
    } else {
      input = el('input', {
        id, type,
        value: data[key] != null ? String(data[key]) : '',
        onInput: e => data[key] = type === 'number' ? Number(e.target.value) : e.target.value,
      });
    }
    return el('div', { class: 'form-field' }, [el('label', { for: id }, [label]), input]);
  });

  const modal = el('div', { class: 'modal-backdrop', onClick: e => { if (e.target === modal) modal.remove(); } }, [
    el('div', { class: 'modal' }, [
      el('h3', { style: { marginBottom: 'var(--s3)' } }, [isNew ? 'Add person' : `Edit ${person.name}`]),
      ...inputs,
      el('div', { class: 'row spaced', style: { marginTop: 'var(--s4)' } }, [
        el('button', { class: 'btn btn-ghost', onClick: () => modal.remove() }, ['Cancel']),
        el('button', { class: 'btn btn-primary', onClick: async () => {
          try {
            if (isNew) await api.post('/api/admin/people', data);
            else await api.patch(`/api/admin/people/${person.id}`, data);
            modal.remove();
            await renderPeople(host);
          } catch (e) { alert(e.message); }
        }}, ['Save']),
      ]),
    ]),
  ]);
  document.body.appendChild(modal);
}

/* ───── Chores tab ───── */
async function renderChores(host) {
  clear(host);
  const [{ chores }, { people }] = await Promise.all([
    api.get('/api/admin/chores'),
    api.get('/api/admin/people'),
  ]);
  const kids = people.filter(p => p.role === 'kid');

  const rows = chores.map(c => el('div', { class: 'list-row', onClick: () => editChore(c, host, kids) }, [
    el('div', {}, [
      el('div', { style: { fontWeight: 600 } }, [c.title]),
      el('div', { class: 'muted', style: { fontSize: '0.78rem' } }, [
        `${c.recurs} · ${c.anti_cheat} · ${c.points} pts`
      ]),
    ]),
    el('button', { class: 'btn btn-ghost' }, ['Edit']),
  ]));
  host.appendChild(el('div', { class: 'row spaced', style: { marginBottom: 'var(--s3)' } }, [
    el('h3', {}, ['Chores']),
    el('button', { class: 'btn btn-primary', onClick: () => editChore(null, host, kids) }, ['+ Add']),
  ]));
  host.appendChild(el('div', { class: 'stack' }, rows));
}

function editChore(chore, host, kids) {
  const isNew = !chore;
  const data = chore ? { ...chore } : {
    title: '', points: 5, kind: 'recurring', recurs: 'daily', anti_cheat: 'honor',
    default_assignees: '', recurs_days: '',
  };
  const assigneeSet = new Set((data.default_assignees || '').split(',').filter(Boolean).map(Number));

  const fields = [
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Title']),
      el('input', { value: data.title, onInput: e => data.title = e.target.value }),
    ]),
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Points']),
      el('input', { type: 'number', value: data.points, onInput: e => data.points = Number(e.target.value) }),
    ]),
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Recurs']),
      el('select', { onChange: e => data.recurs = e.target.value },
        ['daily','weekly','biweekly','monthly','none'].map(o =>
          el('option', { value: o, selected: data.recurs === o }, [o]))),
    ]),
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Days of week (0=Sun..6=Sat, comma-separated; weekly/biweekly only)']),
      el('input', { value: data.recurs_days || '', onInput: e => data.recurs_days = e.target.value }),
    ]),
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Anti-cheat']),
      el('select', { onChange: e => data.anti_cheat = e.target.value },
        ['honor','photo','approval'].map(o =>
          el('option', { value: o, selected: data.anti_cheat === o }, [o]))),
    ]),
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Assigned to']),
      el('div', { class: 'row' },
        kids.map(k => el('label', { class: 'row', style: { gap: '6px', marginRight: '12px' } }, [
          el('input', {
            type: 'checkbox',
            checked: assigneeSet.has(k.id),
            onChange: e => {
              if (e.target.checked) assigneeSet.add(k.id); else assigneeSet.delete(k.id);
              data.default_assignees = [...assigneeSet].join(',');
            },
          }),
          k.name,
        ]))),
    ]),
  ];

  const modal = el('div', { class: 'modal-backdrop', onClick: e => { if (e.target === modal) modal.remove(); } }, [
    el('div', { class: 'modal' }, [
      el('h3', { style: { marginBottom: 'var(--s3)' } }, [isNew ? 'New chore' : `Edit ${chore.title}`]),
      ...fields,
      el('div', { class: 'row spaced', style: { marginTop: 'var(--s4)' } }, [
        chore ? el('button', { class: 'btn btn-danger', onClick: async () => {
          if (!confirm(`Delete ${chore.title}?`)) return;
          await api.del(`/api/admin/chores/${chore.id}`);
          modal.remove();
          await renderChores(host);
        }}, ['Delete']) : el('span', {}, ['']),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn btn-ghost', onClick: () => modal.remove() }, ['Cancel']),
          el('button', { class: 'btn btn-primary', onClick: async () => {
            try {
              if (isNew) await api.post('/api/admin/chores', data);
              else await api.patch(`/api/admin/chores/${chore.id}`, data);
              modal.remove();
              await renderChores(host);
            } catch (e) { alert(e.message); }
          }}, ['Save']),
        ]),
      ]),
    ]),
  ]);
  document.body.appendChild(modal);
}
```

- [ ] **Step 3: Manual smoke test**

Run: `npm run dev`. Log in as parent. Verify:
- Three tabs visible (Today / People / Chores)
- Today shows house progress + per-kid summary
- People tab: list parent; click "+ Add" → modal → create a kid "Christopher" → saved
- Chores tab: "+ Add" → create "Make bed" (5 pts, daily, honor, assigned to Christopher) → saved
- Stop and restart server (or wait an hour) → the chore appears as an assignment

- [ ] **Step 4: Commit**

```bash
git add public/js/pages/admin.js public/css/layouts.css
git commit -m "feat(spa): admin page with Today, People, Chores tabs"
```

---

## Task 22: Wall display page

**Files:**
- Create: `public/wall.html`, `public/js/pages/wall.js`
- Modify: `public/css/layouts.css`

- [ ] **Step 1: Append wall styles to `public/css/layouts.css`**

```css
.wall-page {
  height: 100vh; padding: 28px 32px;
  display: flex; flex-direction: column; gap: 16px;
  background: var(--bg); color: var(--ink);
  font-family: var(--font-ui);
}
.wall-header { display: flex; justify-content: space-between; align-items: baseline; }
.wall-header h2 { font-size: 2rem; font-weight: 700; letter-spacing: -1px; }
.wall-header .t { font-family: var(--font-num); font-size: 1.4rem; color: var(--muted); }
.wall-banner {
  background: linear-gradient(135deg, var(--hero-bg-1), var(--hero-bg-2));
  color: var(--hero-ink);
  border-radius: var(--r-xl);
  padding: 20px 28px;
  display: flex; justify-content: space-between; align-items: center;
  position: relative; overflow: hidden;
}
.wall-banner::after {
  content:''; position: absolute; right: -60px; top: -60px;
  width: 200px; height: 200px; border-radius: 50%;
  background: radial-gradient(circle, var(--hero-glow), transparent 70%);
}
.wall-banner .pct {
  font-family: var(--font-num); font-size: 3.5rem; font-weight: 600; letter-spacing: -2px;
}
.wall-banner .pct .denom { font-size: 1.6rem; color: var(--hero-muted); }
.wall-banner .pct-label { color: var(--hero-muted); }
.wall-stats { display: flex; gap: 28px; position: relative; z-index: 1; }
.wall-stats .st-num { font-family: var(--font-num); font-size: 2rem; font-weight: 600; }
.wall-stats .st-name { color: var(--hero-muted); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 1.4px; }
.wall-cols { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; flex: 1; min-height: 0; }
.wall-col {
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--r-lg); padding: 18px;
  display: flex; flex-direction: column; gap: 8px;
  overflow: hidden;
}
.wall-col .col-head { display: flex; justify-content: space-between; align-items: center; }
.wall-col .col-head h3 { font-size: 1.2rem; font-weight: 600; }
.wall-col .meta { display: flex; gap: 12px; font-family: var(--font-num); font-size: 0.8rem; color: var(--muted); }
.wall-col .task {
  background: var(--card-muted);
  border-radius: var(--r-sm); padding: 8px 12px;
  font-size: 0.92rem;
  display: flex; justify-content: space-between; align-items: center;
}
.wall-col .task.done { color: var(--muted); text-decoration: line-through; }
.wall-col .task.over { background: #FEF2F2; color: var(--red); }
.wall-col .task .p { font-family: var(--font-num); font-weight: 600; color: var(--green); }
.wall-col .task.done .p { color: var(--muted); }
```

- [ ] **Step 2: Create `public/wall.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tally · Wall</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/css/tokens.css" />
  <link rel="stylesheet" href="/css/base.css" />
  <link rel="stylesheet" href="/css/components.css" />
  <link rel="stylesheet" href="/css/layouts.css" />
  <style>html, body { overflow: hidden; }</style>
</head>
<body>
  <div id="wall"></div>
  <script type="module" src="/js/pages/wall.js"></script>
</body>
</html>
```

- [ ] **Step 3: Create `public/js/pages/wall.js`**

```js
import { api } from '../lib/api.js';
import { el, clear } from '../lib/dom.js';

const root = document.getElementById('wall');

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

async function applyServerTheme() {
  // Wall theme is set in the settings table as 'wall_theme' (system/light/dark).
  // For Phase 1 we use system preference; explicit fetch via a public endpoint
  // can be added in Phase 6 along with the dark-mode toggle.
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

function fmtTime(d) {
  const h = d.getHours() % 12 || 12;
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = d.getHours() < 12 ? 'AM' : 'PM';
  return `${h}:${m} ${ampm}`;
}

function fmtDate(d) {
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

async function render() {
  await applyServerTheme();
  const data = await api.get('/api/wall').catch(() => null);
  if (!data) {
    clear(root);
    root.appendChild(el('div', { class: 'wall-page' }, [
      el('h2', {}, ['Connecting…']),
    ]));
    return;
  }
  const now = new Date();
  clear(root);

  const banner = el('div', { class: 'wall-banner' }, [
    el('div', {}, [
      el('div', { class: 'pct-label label' }, ['House progress today']),
      el('div', { class: 'pct' }, [String(data.house_pct), el('span', { class: 'denom' }, ['%'])]),
    ]),
    el('div', { class: 'wall-stats' },
      data.kids.map(k => el('div', {}, [
        el('div', { class: 'st-num' }, [`${k.today.filter(t => t.status === 'done').length}/${k.today.length}`]),
        el('div', { class: 'st-name' }, [k.name]),
      ]))
    ),
  ]);

  const cols = el('div', { class: 'wall-cols' },
    data.kids.map(k => {
      const tasks = [
        ...k.today.map(t => ({ ...t, over: false })),
        ...k.overdue.map(t => ({ ...t, over: true })),
      ];
      return el('div', { class: 'wall-col' }, [
        el('div', { class: 'col-head' }, [
          el('h3', {}, [k.name]),
          el('div', { class: 'av', style: { background: k.avatar_color, width: '32px', height: '32px' } }, [k.name[0]]),
        ]),
        el('div', { class: 'meta' }, [
          el('span', {}, [`target ${k.weekly_target_pts || 0} pts`]),
          el('span', {}, [`${k.streak_days || 0}d streak`]),
        ]),
        el('div', { class: 'stack', style: { gap: '6px' } },
          tasks.length === 0
            ? [el('p', { class: 'muted', style: { fontSize: '0.85rem' } }, ['All clear.'])]
            : tasks.map(t => el('div', {
                class: 'task' + (t.status === 'done' ? ' done' : '') + (t.over ? ' over' : ''),
              }, [
                el('span', {}, [t.title]),
                el('span', { class: 'p' }, [`+${t.points}`]),
              ]))
        ),
      ]);
    })
  );

  root.appendChild(el('div', { class: 'wall-page' }, [
    el('div', { class: 'wall-header' }, [
      el('h2', {}, [`The Lopez House · ${fmtDate(now)}`]),
      el('span', { class: 't' }, [fmtTime(now)]),
    ]),
    banner,
    cols,
  ]));
}

render();
setInterval(render, 10_000);
```

- [ ] **Step 4: Manual smoke test**

Visit http://localhost:3007/wall.html in a browser. Verify:
- Header shows date + time
- Banner shows house progress %
- Three columns (or however many kids exist)
- Refreshes every 10s

- [ ] **Step 5: Commit**

```bash
git add public/wall.html public/js/pages/wall.js public/css/layouts.css
git commit -m "feat(wall): wall display HTML, JS, and styles"
```

---

## Task 23: Wall route alias `/wall` → `/wall.html`

**Files:**
- Modify: `src/app.js`

- [ ] **Step 1: Modify `src/app.js`**

Add this line just before `app.use(express.static(...))`:

```js
app.get('/wall', (_req, res) => res.sendFile(join(__dirname, '..', 'public', 'wall.html')));
```

- [ ] **Step 2: Verify**

Run: `npm run dev` then visit http://localhost:3007/wall — should serve the wall page.

- [ ] **Step 3: Commit**

```bash
git add src/app.js
git commit -m "feat(wall): alias /wall to wall.html"
```

---

## Task 24: PM2 ecosystem + deployment notes

**Files:**
- Create: `ecosystem.config.js`
- Modify: `README.md`

- [ ] **Step 1: Create `ecosystem.config.js`**

```js
export default {
  apps: [{
    name: 'tally',
    script: './server.js',
    cwd: '/home/jeffrey/projects/tally',
    env: {
      PORT: 3007,
      SESSION_SECRET: 'CHANGE_THIS_BEFORE_DEPLOY',
      NODE_ENV: 'production',
    },
    out_file: '/home/jeffrey/.pm2/logs/tally-out.log',
    error_file: '/home/jeffrey/.pm2/logs/tally-err.log',
    max_memory_restart: '300M',
  }],
};
```

- [ ] **Step 2: Expand `README.md`**

```markdown
# Tally

Household chores + allowance for the Lopez family.

## Dev
\`\`\`bash
npm install
npm run dev
\`\`\`
Open http://localhost:3007 (kid/parent app) or http://localhost:3007/wall (wall display).

## Test
\`\`\`bash
npm test
\`\`\`

## Production (acutis-box)

1. Set a real session secret in `ecosystem.config.js` or via env.
2. Start under PM2:
   \`\`\`bash
   pm2 start ecosystem.config.js
   pm2 save
   \`\`\`
3. Add Cloudflare Tunnel route `tally.thelopezfamily.org` → `http://localhost:3007` via the Cloudflare Public Hostname tab (token-mode tunnel; not DNS-only).
4. On the Raspberry Pi kiosk, configure Chromium to launch in kiosk mode pointing at `https://tally.thelopezfamily.org/wall`.

## Spec
See `docs/superpowers/specs/2026-05-26-tally-design.md`.

## Phase status
- [x] Phase 1: Skeleton (this PR)
- [ ] Phase 2: Economy v1
- [ ] Phase 3: Anti-cheat
- [ ] Phase 4: Bonus board
- [ ] Phase 5: Realtime (SSE)
- [ ] Phase 6: Polish (streaks, confetti, dark-mode toggle, sick day, audit, undo, CSV)
- [ ] Phase 7: Notifications
```

- [ ] **Step 3: Commit**

```bash
git add ecosystem.config.js README.md
git commit -m "chore(deploy): PM2 ecosystem + deployment README"
```

---

## Task 25: End-to-end smoke pass + Phase 1 ship

- [ ] **Step 1: Stop any local server, clear DB, restart fresh**

```bash
rm -f tally.db
npm run dev
```

- [ ] **Step 2: Walk through the full user story manually**

In a browser at http://localhost:3007:
1. Picker shows. There's only the parent placeholder seeded; click it and enter PIN `1234`.
2. Admin → People tab → Add. Create Christopher (kid, 60 target pts, dob 2016-07-02, color #6366F1), Olivia (kid, 100, 2013-10-02, #22C55E), Gabriel (kid, 150, 2011-01-25, #D4A017).
3. Chores tab → Add a daily "Make bed" worth 5 pts, anti-cheat honor, assigned to all three kids.
4. Sign out.
5. Picker → select Christopher. Verify hero card + chore "Make bed +5". Tap it → struck through.
6. Visit `/wall` in another tab → wall shows the three columns. Within 10s, Christopher's "Make bed" is struck through; house % shows 1/3 = 33%.

- [ ] **Step 3: Run the full test suite one last time**

Run: `npm test`
Expected: every test passes.

- [ ] **Step 4: Final commit + tag**

```bash
git add -A
git commit -m "chore: phase 1 complete" --allow-empty
git tag v0.1.0-phase1
```

- [ ] **Step 5: Deploy to acutis-box**

```bash
# On acutis-box, in ~/projects/tally:
git pull
npm install
pm2 start ecosystem.config.js
pm2 save
# Configure tally.thelopezfamily.org tunnel via Cloudflare dashboard (Public Hostname tab)
```

Set up the Raspberry Pi kiosk per the README.

---

## Self-Review (after writing, before handoff)

**Spec coverage check** (matched task → spec section):

| Spec section | Covered by |
|---|---|
| §3 Non-goals | Honored throughout — no economy/ledger/photo/SSE/push in this plan |
| §4 Users + identity | Tasks 7, 8, 19 |
| §5.1 Wall display | Tasks 12, 22, 23 |
| §5.2 Phone PWA (kid home) | Tasks 11, 17, 18, 20 |
| §5.3 Parent admin (Phase 1 subset: Dashboard/People/Chores) | Tasks 13, 14, 15, 21 |
| §6 Economy | Deferred to Phase 2 (column for points/target exists in schema) |
| §7 Anti-cheat | `anti_cheat` column exists; only `honor` flow implemented this phase (Phase 3 deferred for photo+approval) |
| §8 Bonus board | Phase 4 deferred |
| §9 Realtime | Phase 5 deferred (polling at 10s in this phase) |
| §10 Notifications | Phase 7 deferred |
| §11 Visual system | Task 16 (tokens.css, components.css with hero card signature) |
| §12 Data model | Tasks 2, 3, 4 — Phase 1 needs people/sessions/settings/chores/assignments. ledger/weekly_summary/bonus_claims/push_subscriptions/admin_audit deferred to their respective phases |
| §13 API surface | Tasks 8, 11, 12, 13, 14, 15 cover Phase 1 endpoints |
| §14 Stack and deployment | Task 24 |
| §15 Build phases | This plan = Phase 1 only, by design |

**Placeholder scan**: every step has either runnable code, an exact shell command, or a discrete UI verification. No TBDs.

**Type consistency check**:
- `assignments.status` enum used identically in routes-home, routes-wall, routes-admin-today (`'done','expired','rejected'` for the not-overdue exclusion).
- `chores.anti_cheat` values match the CHECK constraint and the home route's `'honor'` filter.
- `freshDb()` + `freshApp(db)` helper signatures stable across test files.
- API path `/api/assignments/:id/done` consistent between server (Task 11) and client (Task 20).

Plan is internally consistent. Ready for execution.

---

## Execution Handoff

Plan complete and saved to [`docs/superpowers/plans/2026-05-26-tally-phase-1-skeleton.md`](./2026-05-26-tally-phase-1-skeleton.md). Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
