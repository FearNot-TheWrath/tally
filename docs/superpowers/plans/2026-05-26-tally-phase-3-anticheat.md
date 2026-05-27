# Tally — Phase 3 (Anti-cheat) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make photo-flagged and approval-flagged chores actually completable: kid taps a chore, captures a photo (or just submits for approval), parent reviews from admin, approves or rejects.

**Architecture:** New `POST /api/assignments/:id/submit` endpoint accepts an optional multipart photo upload (multer + sharp for resize + EXIF strip), persists to `./uploads/YYYY-MM/<id>.jpg`, and moves the assignment to `status='submitted'`. New `POST /api/assignments/:id/approve` and `/reject` endpoints let parents resolve the queue; both delete the photo file and null `photo_path` since the photo is no longer needed once reviewed. New `Approvals` admin tab shows the pending queue with inline photos. Photo files served through an auth-gated `/uploads/...` route so siblings can't browse each other's submissions. Kid home replaces the "Needs photo" / "Needs approval" pills with active flow buttons. A daily retention sweep deletes any photo file older than 5 days as a catch-all for abandoned submissions.

**Tech Stack:**
- Server: multer (^1.4.5-lts), sharp (^0.33), existing Express 5 + better-sqlite3
- Frontend: existing vanilla JS, `<input type="file" accept="image/*" capture="environment">` for camera capture, native FormData for upload
- Storage: filesystem at `./uploads/YYYY-MM/`, gitignored

**Spec:** [`docs/superpowers/specs/2026-05-26-tally-design.md`](../specs/2026-05-26-tally-design.md) §7 (Anti-cheat)
**Prior phase:** [Phase 1 plan](2026-05-26-tally-phase-1-skeleton.md) (skeleton + honor flow)

**Scope guardrails (deferred to later phases):**
- Phase 2: economy / points credit / ledger (still deferred — Phase 3 sets `points_earned` on approve but doesn't track per-week totals yet)
- Phase 5: SSE realtime push when approvals land
- Phase 7: Web Push notification to parents on new submission

**Schema:** No migration needed. The `assignments` table from migration 002 already has `submitted_at`, `approved_at`, `approved_by`, `photo_path`, `note`, `points_earned`, `late` columns ready to use.

---

## File Structure

```
~/projects/tally/
├── package.json                     -- + multer, sharp dependencies
├── .gitignore                       -- + uploads/ (already there)
├── server.js                        -- ensure uploads dir exists on boot
├── src/
│   ├── app.js                       -- mount new routes + uploads gate
│   ├── lib/
│   │   └── photo.js                 -- NEW: save upload, resize, strip EXIF
│   └── routes/
│       ├── home.js                  -- MODIFY: add POST /assignments/:id/submit
│       └── admin/
│           └── approvals.js         -- NEW: queue + approve + reject + photo serve
└── public/
    ├── js/pages/
    │   ├── home.js                  -- MODIFY: photo capture + approval submit
    │   └── admin.js                 -- MODIFY: add Approvals tab
    └── css/
        └── layouts.css              -- + approval card styles, capture button

tests/
├── routes-submit.test.js            -- NEW: submit flow for honor (no-op), photo, approval
├── routes-admin-approvals.test.js   -- NEW: queue, approve, reject, photo auth gate
└── lib-photo.test.js                -- NEW: storage path, resize, EXIF strip
```

---

## Task 1: Install multer + sharp + ensure uploads dir + .gitignore

**Files:**
- Modify: `package.json`, `.gitignore`, `server.js`

- [ ] **Step 1: Install dependencies**

```bash
cd ~/projects/tally && npm install multer@1.4.5-lts.1 sharp@0.33.5
```

Expected: `package.json` updated with both deps, no errors.

- [ ] **Step 2: Confirm `.gitignore` already has `uploads/`**

```bash
grep -c "^uploads/$" ~/projects/tally/.gitignore
```

Expected: `1`. If 0, append `uploads/` to `.gitignore`.

- [ ] **Step 3: Modify `server.js` to ensure uploads dir exists on boot**

Read the current `server.js`. Insert the `mkdirSync` call immediately after the `openDb` line. Final file:

```js
import { mkdirSync } from 'node:fs';
import { openDb } from './src/db.js';
import { buildApp } from './src/app.js';
import { generateForToday } from './src/lib/assignments.js';

const PORT = process.env.PORT || 3007;
const SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';

const db = openDb('./tally.db');
mkdirSync('./uploads', { recursive: true });

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

- [ ] **Step 4: Run tests to verify nothing broke**

```bash
cd ~/projects/tally && npm test
```

Expected: 32 tests still pass.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add package.json package-lock.json server.js && git commit -m "chore(deps): add multer + sharp, ensure uploads dir on boot"
```

---

## Task 2: Photo storage utility (resize + EXIF strip)

**Files:**
- Create: `src/lib/photo.js`, `tests/lib-photo.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/lib-photo.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { savePhoto } from '../src/lib/photo.js';

async function makeJpeg() {
  // 800x600 plain red, with a fake EXIF tag we expect to be stripped.
  return await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .withMetadata({ exif: { IFD0: { Software: 'TallyTest' } } })
    .jpeg().toBuffer();
}

test('savePhoto writes a resized JPEG to uploads/YYYY-MM/<id>.jpg and strips EXIF', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tally-photos-'));
  try {
    const buf = await makeJpeg();
    const path = await savePhoto(buf, 42, root);

    assert.ok(existsSync(path), 'file should be on disk');
    assert.match(path, /uploads\/\d{4}-\d{2}\/42\.jpg$/);

    const meta = await sharp(path).metadata();
    assert.ok(meta.width <= 1600, 'should be resized to <= 1600 wide');
    assert.equal(meta.exif, undefined, 'EXIF should be stripped');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('savePhoto rejects non-image buffers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tally-photos-'));
  try {
    await assert.rejects(
      () => savePhoto(Buffer.from('not an image'), 1, root),
      /Invalid image/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL — `src/lib/photo.js` not found.

- [ ] **Step 3: Create `src/lib/photo.js`**

```js
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const MAX_WIDTH = 1600;
const JPEG_QUALITY = 82;

export async function savePhoto(buffer, assignmentId, rootDir = './uploads') {
  let processed;
  try {
    processed = await sharp(buffer)
      .rotate()
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
  } catch (e) {
    throw new Error(`Invalid image: ${e.message}`);
  }

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dir = join(rootDir, `${yyyy}-${mm}`);
  mkdirSync(dir, { recursive: true });

  const path = join(dir, `${assignmentId}.jpg`);
  writeFileSync(path, processed);
  return path;
}

export function photoRelPath(absPath) {
  const idx = absPath.indexOf('uploads/');
  return idx === -1 ? absPath : absPath.slice(idx);
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 34 tests (32 prior + 2 new).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/lib/photo.js tests/lib-photo.test.js && git commit -m "feat(lib): savePhoto with sharp resize + EXIF strip"
```

---

## Task 3: Unified `POST /api/assignments/:id/submit` endpoint

**Files:**
- Modify: `src/routes/home.js`
- Create: `tests/routes-submit.test.js`

Handles three cases by chore.anti_cheat:
- `honor` → behave like the existing /done endpoint (status=done, points_earned set)
- `approval` → status='submitted', no photo
- `photo` → status='submitted', requires multipart photo, stored via savePhoto

- [ ] **Step 1: Write the failing tests**

Create `tests/routes-submit.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { freshApp, freshDb } from './helpers.js';

function seedChore(db, antiCheat, kidId) {
  return db.prepare(`
    INSERT INTO chores (title, points, recurs, default_assignees, anti_cheat)
    VALUES ('Test', 5, 'daily', ?, ?) RETURNING id
  `).get(String(kidId), antiCheat).id;
}
function seedAssignment(db, choreId, kidId) {
  return db.prepare(`
    INSERT INTO assignments (chore_id, person_id, due_date, status)
    VALUES (?, ?, date('now'), 'pending') RETURNING id
  `).get(choreId, kidId).id;
}
async function loginKid(app, kidId) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: kidId });
  return agent;
}
async function jpeg() {
  return await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 0, g: 255, b: 0 } },
  }).jpeg().toBuffer();
}

test('submit on honor chore moves status to done', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const cId = seedChore(db, 'honor', kid);
  const aId = seedAssignment(db, cId, kid);
  const app = freshApp(db);
  const agent = await loginKid(app, kid);

  const res = await agent.post(`/api/assignments/${aId}/submit`);
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT status FROM assignments WHERE id = ?').get(aId).status, 'done');
});

test('submit on approval chore moves status to submitted', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const cId = seedChore(db, 'approval', kid);
  const aId = seedAssignment(db, cId, kid);
  const app = freshApp(db);
  const agent = await loginKid(app, kid);

  const res = await agent.post(`/api/assignments/${aId}/submit`).send({ note: 'finished' });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT * FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'submitted');
  assert.equal(row.note, 'finished');
  assert.ok(row.submitted_at);
});

test('submit on photo chore without a photo rejects with 400', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const cId = seedChore(db, 'photo', kid);
  const aId = seedAssignment(db, cId, kid);
  const app = freshApp(db);
  const agent = await loginKid(app, kid);

  const res = await agent.post(`/api/assignments/${aId}/submit`);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /photo required/i);
});

test('submit on photo chore WITH photo stores file and sets submitted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tally-submit-'));
  try {
    const db = freshDb();
    const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
    const cId = seedChore(db, 'photo', kid);
    const aId = seedAssignment(db, cId, kid);
    const app = freshApp(db, { uploadsDir: root });
    const agent = await loginKid(app, kid);

    const res = await agent.post(`/api/assignments/${aId}/submit`)
      .attach('photo', await jpeg(), { filename: 'cam.jpg', contentType: 'image/jpeg' });
    assert.equal(res.status, 200);
    const row = db.prepare('SELECT * FROM assignments WHERE id = ?').get(aId);
    assert.equal(row.status, 'submitted');
    assert.ok(row.photo_path && row.photo_path.endsWith(`${aId}.jpg`));
    assert.ok(existsSync(row.photo_path));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('submit rejects assignment belonging to another kid', async () => {
  const db = freshDb();
  const a = db.prepare("INSERT INTO people (name, role) VALUES ('A','kid') RETURNING id").get().id;
  const b = db.prepare("INSERT INTO people (name, role) VALUES ('B','kid') RETURNING id").get().id;
  const cId = seedChore(db, 'honor', a);
  const aId = seedAssignment(db, cId, a);
  const app = freshApp(db);
  const agent = await loginKid(app, b);

  const res = await agent.post(`/api/assignments/${aId}/submit`);
  assert.equal(res.status, 403);
});
```

- [ ] **Step 2: Update `freshApp` helper to accept `uploadsDir`**

Read `tests/helpers.js`. Replace with:

```js
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';
import { buildApp } from '../src/app.js';

export function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

export function freshApp(db, opts = {}) {
  return buildApp({
    db: db || freshDb(),
    sessionSecret: 'test-secret',
    uploadsDir: opts.uploadsDir,
  });
}
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL — `/submit` route doesn't exist.

- [ ] **Step 4: Update `src/routes/home.js` to add the submit endpoint**

Read the current file. Replace the `homeRoutes` factory with:

```js
import { Router } from 'express';
import multer from 'multer';
import { requireRole, requireAnyAuth } from '../auth.js';
import { today } from '../lib/dates.js';
import { savePhoto } from '../lib/photo.js';

export function homeRoutes({ uploadsDir = './uploads' } = {}) {
  const r = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  });

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

  // Backward-compat for honor chores; deprecated, /submit is preferred.
  r.post('/assignments/:id/done', requireAnyAuth, (req, res) => {
    return doSubmit(req, res, { honorOnly: true });
  });

  r.post('/assignments/:id/submit', requireAnyAuth, upload.single('photo'), (req, res) => {
    return doSubmit(req, res, { uploadsDir });
  });

  return r;
}

function doSubmit(req, res, { honorOnly = false, uploadsDir = './uploads' } = {}) {
  const db = req.app.get('db');
  const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (a.person_id !== req.user.person_id && req.user.role !== 'parent') {
    return res.status(403).json({ error: 'Not your assignment' });
  }
  const chore = db.prepare('SELECT anti_cheat, points FROM chores WHERE id = ?').get(a.chore_id);
  if (honorOnly && chore.anti_cheat !== 'honor') {
    return res.status(400).json({ error: 'Use /submit for photo/approval chores' });
  }

  if (chore.anti_cheat === 'honor') {
    db.prepare(`
      UPDATE assignments
      SET status = 'done',
          updated_at = datetime('now'),
          late = CASE WHEN due_date < date('now') THEN 1 ELSE 0 END,
          points_earned = ?
      WHERE id = ?
    `).run(chore.points, req.params.id);
    return res.json({ ok: true, status: 'done' });
  }

  if (chore.anti_cheat === 'approval') {
    db.prepare(`
      UPDATE assignments
      SET status = 'submitted', submitted_at = datetime('now'),
          note = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(req.body?.note || '', req.params.id);
    return res.json({ ok: true, status: 'submitted' });
  }

  // anti_cheat === 'photo'
  if (!req.file) return res.status(400).json({ error: 'Photo required for this chore' });
  return savePhoto(req.file.buffer, Number(req.params.id), uploadsDir)
    .then(absPath => {
      db.prepare(`
        UPDATE assignments
        SET status = 'submitted', submitted_at = datetime('now'),
            photo_path = ?, note = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(absPath, req.body?.note || '', req.params.id);
      res.json({ ok: true, status: 'submitted' });
    })
    .catch(err => res.status(400).json({ error: err.message }));
}
```

- [ ] **Step 5: Update `src/app.js` to pass uploadsDir to homeRoutes**

Read current file. Change the line `app.use('/api', homeRoutes());` to `app.use('/api', homeRoutes({ uploadsDir }));` and add `uploadsDir = './uploads'` to the buildApp options destructure. Final file:

```js
import express from 'express';
import cookieSession from 'cookie-session';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { authRoutes, meRoute } from './routes/auth.js';
import { homeRoutes } from './routes/home.js';
import { wallRoutes } from './routes/wall.js';
import { adminPeopleRoutes } from './routes/admin/people.js';
import { adminChoresRoutes } from './routes/admin/chores.js';
import { adminTodayRoutes } from './routes/admin/today.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildApp({ db, sessionSecret = 'dev-secret', uploadsDir = './uploads' }) {
  const app = express();
  app.set('db', db);
  app.set('uploadsDir', uploadsDir);
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
  app.use('/api', homeRoutes({ uploadsDir }));
  app.use('/api', wallRoutes());
  app.use('/api/admin', adminPeopleRoutes());
  app.use('/api/admin', adminChoresRoutes());
  app.use('/api/admin', adminTodayRoutes());

  app.get('/wall', (_req, res) => res.sendFile(join(__dirname, '..', 'public', 'wall.html')));
  app.use(express.static(join(__dirname, '..', 'public')));

  return app;
}
```

- [ ] **Step 6: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 39 tests (34 prior + 5 new).

- [ ] **Step 7: Commit**

```bash
cd ~/projects/tally && git add src/routes/home.js src/app.js tests/helpers.js tests/routes-submit.test.js && git commit -m "feat(home): POST /api/assignments/:id/submit handles honor/approval/photo"
```

---

## Task 4: Admin approvals endpoints (list, approve, reject) + photo serving

**Files:**
- Create: `src/routes/admin/approvals.js`, `tests/routes-admin-approvals.test.js`
- Modify: `src/app.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/routes-admin-approvals.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshApp, freshDb } from './helpers.js';

async function asParent(app, db) {
  const id = db.prepare("INSERT INTO people (name, role) VALUES ('Mom','parent') RETURNING id").get().id;
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id, pin: '1234' });
  return { agent, id };
}
function seedSubmitted(db, kidId, options = {}) {
  const c = db.prepare(`
    INSERT INTO chores (title, points, recurs, default_assignees, anti_cheat)
    VALUES ('T', 5, 'daily', ?, ?) RETURNING id
  `).get(String(kidId), options.antiCheat || 'photo').id;
  return db.prepare(`
    INSERT INTO assignments (chore_id, person_id, due_date, status, submitted_at, photo_path, note)
    VALUES (?, ?, date('now'), 'submitted', datetime('now'), ?, ?) RETURNING id
  `).get(c, kidId, options.photoPath || null, options.note || '').id;
}

test('GET /api/admin/approvals returns submitted assignments with kid + chore + photo info', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid','avatar_color' = '#000') RETURNING id").get?.()?.id
    ?? db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  seedSubmitted(db, kid, { photoPath: '/some/where/42.jpg' });
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const res = await agent.get('/api/admin/approvals');
  assert.equal(res.status, 200);
  assert.equal(res.body.approvals.length, 1);
  assert.equal(res.body.approvals[0].kid_name, 'K');
  assert.equal(res.body.approvals[0].chore_title, 'T');
  assert.ok(res.body.approvals[0].photo_url);
});

test('approve sets status=done, points_earned, approved_at, approved_by', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const aId = seedSubmitted(db, kid);
  const app = freshApp(db);
  const { agent, id: parentId } = await asParent(app, db);
  const res = await agent.post(`/api/admin/approvals/${aId}/approve`);
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT * FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'done');
  assert.equal(row.points_earned, 5);
  assert.equal(row.approved_by, parentId);
  assert.ok(row.approved_at);
});

test('approve with point override sets that points_earned value', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const aId = seedSubmitted(db, kid);
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const res = await agent.post(`/api/admin/approvals/${aId}/approve`).send({ points: 2 });
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT points_earned FROM assignments WHERE id = ?').get(aId).points_earned, 2);
});

test('reject sets status=pending and stores note', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const aId = seedSubmitted(db, kid);
  const app = freshApp(db);
  const { agent } = await asParent(app, db);
  const res = await agent.post(`/api/admin/approvals/${aId}/reject`).send({ note: 'still messy' });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT * FROM assignments WHERE id = ?').get(aId);
  assert.equal(row.status, 'pending');
  assert.equal(row.note, 'still messy');
});

test('approvals queue rejects non-parents', async () => {
  const db = freshDb();
  const kid = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
  const app = freshApp(db);
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: kid });
  const res = await agent.get('/api/admin/approvals');
  assert.equal(res.status, 403);
});

test('photo serving requires auth (parent or owning kid); strangers get 401/403', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tally-served-'));
  try {
    const dir = join(root, '2026-05');
    require('node:fs').mkdirSync(dir, { recursive: true });
    const filePath = join(dir, '99.jpg');
    writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff])); // jpeg magic bytes
    const db = freshDb();
    const owner = db.prepare("INSERT INTO people (name, role) VALUES ('K','kid') RETURNING id").get().id;
    const other = db.prepare("INSERT INTO people (name, role) VALUES ('K2','kid') RETURNING id").get().id;
    const cId = db.prepare("INSERT INTO chores (title, points, default_assignees, anti_cheat) VALUES ('X',5,?,'photo') RETURNING id").get(String(owner)).id;
    db.prepare(`
      INSERT INTO assignments (id, chore_id, person_id, due_date, status, photo_path)
      VALUES (99, ?, ?, date('now'), 'submitted', ?)
    `).run(cId, owner, filePath);
    const app = freshApp(db, { uploadsDir: root });

    // Unauthenticated → 401
    const r1 = await request(app).get('/api/uploads/2026-05/99.jpg');
    assert.equal(r1.status, 401);

    // Other kid → 403
    const otherAgent = request.agent(app);
    await otherAgent.post('/api/auth/login').send({ person_id: other });
    const r2 = await otherAgent.get('/api/uploads/2026-05/99.jpg');
    assert.equal(r2.status, 403);

    // Parent → 200
    const { agent: parentAgent } = await asParent(app, db);
    const r3 = await parentAgent.get('/api/uploads/2026-05/99.jpg');
    assert.equal(r3.status, 200);
    assert.equal(r3.headers['content-type'], 'image/jpeg');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

Note: the helper `import { writeFileSync, mkdirSync } from 'node:fs'` requires the `mkdirSync` shimmed via `require('node:fs').mkdirSync` in one spot above — using `import` is cleaner. Use `import { writeFileSync, mkdirSync } from 'node:fs';` and call `mkdirSync(...)` instead.

Actually rewrite that test's imports to use top-level ES imports and remove the inline `require`:

Replace the `import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';` line with:

```js
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
```

And replace `require('node:fs').mkdirSync(dir, { recursive: true });` with `mkdirSync(dir, { recursive: true });`.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/projects/tally && npm test
```

Expected: FAIL — `/api/admin/approvals` and `/api/uploads/...` don't exist.

- [ ] **Step 3: Create `src/routes/admin/approvals.js`**

```js
import { Router } from 'express';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { requireRole, requireAnyAuth } from '../../auth.js';

export function adminApprovalsRoutes() {
  const r = Router();
  r.use(requireRole('parent'));

  r.get('/approvals', (req, res) => {
    const db = req.app.get('db');
    const rows = db.prepare(`
      SELECT a.id, a.note, a.photo_path, a.submitted_at, a.due_date,
             c.title AS chore_title, c.points AS chore_points, c.anti_cheat,
             p.id AS kid_id, p.name AS kid_name, p.avatar_color AS kid_color
      FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      JOIN people p ON p.id = a.person_id
      WHERE a.status = 'submitted'
      ORDER BY a.submitted_at ASC
    `).all();
    res.json({
      approvals: rows.map(row => ({
        ...row,
        photo_url: row.photo_path ? `/api/uploads/${relFromUploads(row.photo_path)}` : null,
      })),
    });
  });

  r.post('/approvals/:id/approve', (req, res) => {
    const db = req.app.get('db');
    const a = db.prepare('SELECT * FROM assignments WHERE id = ? AND status = ?').get(req.params.id, 'submitted');
    if (!a) return res.status(404).json({ error: 'Not found or not pending' });
    const chore = db.prepare('SELECT points FROM chores WHERE id = ?').get(a.chore_id);
    const points = Number.isFinite(req.body?.points) ? req.body.points : chore.points;
    db.prepare(`
      UPDATE assignments
      SET status = 'done',
          approved_at = datetime('now'),
          approved_by = ?,
          points_earned = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(req.user.person_id, points, req.params.id);
    res.json({ ok: true });
  });

  r.post('/approvals/:id/reject', (req, res) => {
    const db = req.app.get('db');
    const a = db.prepare('SELECT * FROM assignments WHERE id = ? AND status = ?').get(req.params.id, 'submitted');
    if (!a) return res.status(404).json({ error: 'Not found or not pending' });
    db.prepare(`
      UPDATE assignments
      SET status = 'pending', note = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(req.body?.note || '', req.params.id);
    res.json({ ok: true });
  });

  return r;
}

function relFromUploads(absPath) {
  const i = absPath.indexOf('uploads/');
  if (i === -1) return absPath.split(/[/\\]/).pop();
  return absPath.slice(i + 'uploads/'.length);
}

export function uploadsRoute() {
  const r = Router();
  r.get('/uploads/:yearMonth/:file', requireAnyAuth, (req, res) => {
    const db = req.app.get('db');
    const uploadsDir = req.app.get('uploadsDir') || './uploads';
    const { yearMonth, file } = req.params;
    if (!/^\d{4}-\d{2}$/.test(yearMonth)) return res.status(400).json({ error: 'bad path' });
    if (!/^\d+\.jpg$/.test(file)) return res.status(400).json({ error: 'bad path' });

    const assignmentId = Number(file.replace('.jpg', ''));
    const row = db.prepare('SELECT person_id FROM assignments WHERE id = ?').get(assignmentId);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const isOwner = row.person_id === req.user.person_id;
    const isParent = req.user.role === 'parent';
    if (!isOwner && !isParent) return res.status(403).json({ error: 'Forbidden' });

    const fullPath = resolve(uploadsDir, yearMonth, file);
    if (!existsSync(fullPath)) return res.status(404).json({ error: 'Photo missing' });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Length', statSync(fullPath).size);
    createReadStream(fullPath).pipe(res);
  });
  return r;
}
```

- [ ] **Step 4: Wire in `src/app.js`**

Add the import:
```js
import { adminApprovalsRoutes, uploadsRoute } from './routes/admin/approvals.js';
```

And the mounts (place `uploadsRoute()` BEFORE `express.static` so the auth-gated handler wins):
```js
  app.use('/api/admin', adminApprovalsRoutes());
  app.use('/api', uploadsRoute());
```

Final ordering of routes section:
```js
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes());
  app.use('/api', meRoute());
  app.use('/api', homeRoutes({ uploadsDir }));
  app.use('/api', wallRoutes());
  app.use('/api', uploadsRoute());
  app.use('/api/admin', adminPeopleRoutes());
  app.use('/api/admin', adminChoresRoutes());
  app.use('/api/admin', adminTodayRoutes());
  app.use('/api/admin', adminApprovalsRoutes());

  app.get('/wall', (_req, res) => res.sendFile(join(__dirname, '..', 'public', 'wall.html')));
  app.use(express.static(join(__dirname, '..', 'public')));
```

- [ ] **Step 5: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 45 tests (39 prior + 6 new).

- [ ] **Step 6: Commit**

```bash
cd ~/projects/tally && git add src/routes/admin/approvals.js src/app.js tests/routes-admin-approvals.test.js && git commit -m "feat(admin): approvals queue + approve/reject + auth-gated photo serving"
```

---

## Task 5: Kid home UI — replace pills with active submit flows

**Files:**
- Modify: `public/js/pages/home.js`, `public/css/layouts.css`

- [ ] **Step 1: Replace the `renderTask` function in `public/js/pages/home.js`**

Read the current file. Replace the existing `renderTask` function body with:

```js
function renderTask(a, root, overdue = false) {
  const classes = ['txn'];
  if (a.status === 'done') classes.push('done');
  if (a.status === 'submitted') classes.push('submitted');
  if (overdue) classes.push('over');

  const ico = a.anti_cheat === 'photo' ? 'cam' : a.anti_cheat === 'approval' ? 'appr' : (a.status === 'done' ? 'done' : '');
  const icoText = a.anti_cheat === 'photo' ? 'P' : a.anti_cheat === 'approval' ? 'A' : (a.status === 'done' ? '✓' : a.title[0]);

  let action;
  if (a.status === 'done') {
    action = el('span', { class: 'pts' }, [`+${a.points}`]);
  } else if (a.status === 'submitted') {
    action = el('span', { class: 'pill pill-info' }, ['Waiting for parent']);
  } else if (a.anti_cheat === 'honor') {
    action = el('button', {
      class: 'btn btn-primary btn-done',
      onClick: async (e) => {
        e.stopPropagation();
        e.target.disabled = true;
        e.target.textContent = '…';
        try {
          await api.post(`/api/assignments/${a.id}/submit`);
          renderHome(root);
        } catch (err) {
          alert('Could not mark done: ' + err.message);
          e.target.disabled = false;
          e.target.textContent = `Done · +${a.points}`;
        }
      },
    }, [`Done · +${a.points}`]);
  } else if (a.anti_cheat === 'approval') {
    action = el('button', {
      class: 'btn btn-primary btn-done',
      onClick: async (e) => {
        e.stopPropagation();
        e.target.disabled = true;
        e.target.textContent = '…';
        try {
          await api.post(`/api/assignments/${a.id}/submit`);
          renderHome(root);
        } catch (err) {
          alert('Could not submit: ' + err.message);
          e.target.disabled = false;
          e.target.textContent = `Submit · +${a.points}`;
        }
      },
    }, [`Submit · +${a.points}`]);
  } else if (a.anti_cheat === 'photo') {
    action = el('label', { class: 'btn btn-primary btn-done photo-btn' }, [
      `Photo · +${a.points}`,
      el('input', {
        type: 'file', accept: 'image/*', capture: 'environment',
        style: { display: 'none' },
        onChange: async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          const btn = e.target.parentElement;
          btn.classList.add('btn-loading');
          btn.firstChild.nodeValue = 'Uploading…';
          const fd = new FormData();
          fd.append('photo', file);
          try {
            const res = await fetch(`/api/assignments/${a.id}/submit`, {
              method: 'POST', credentials: 'same-origin', body: fd,
            });
            if (!res.ok) {
              const data = await res.json().catch(() => ({}));
              throw new Error(data.error || res.statusText);
            }
            renderHome(root);
          } catch (err) {
            alert('Upload failed: ' + err.message);
            btn.classList.remove('btn-loading');
            btn.firstChild.nodeValue = `Photo · +${a.points}`;
          }
        },
      }),
    ]);
  }

  return el('div', { class: classes.join(' ') }, [
    el('div', { class: 'left' }, [
      el('div', { class: `ico ${ico}` }, [icoText]),
      el('span', {}, [a.title]),
    ]),
    action,
  ]);
}
```

- [ ] **Step 2: Append CSS for `.photo-btn` and `.submitted` row state to `public/css/layouts.css`**

```css
.photo-btn { cursor: pointer; }
.photo-btn.btn-loading { opacity: 0.6; pointer-events: none; }
.txn.submitted { background: #FAF7FF; border-color: #C7BFEC; color: #5B21B6; }
.txn.submitted .ico { background: #EDE9FE; color: #5B21B6; }
```

- [ ] **Step 3: Smoke test the test suite still passes (no new tests for pure UI)**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 45 tests.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/home.js public/css/layouts.css && git commit -m "feat(home): photo capture + approval submit buttons replace static pills"
```

---

## Task 6: Admin Approvals tab UI

**Files:**
- Modify: `public/js/pages/admin.js`, `public/css/layouts.css`

- [ ] **Step 1: Update the `TABS` constant and add `renderApprovals` in `public/js/pages/admin.js`**

Read the current file. Update the `TABS` declaration:

```js
const TABS = [
  { key: 'today',     label: 'Today',     render: renderToday },
  { key: 'approvals', label: 'Approvals', render: renderApprovals },
  { key: 'people',    label: 'People',    render: renderPeople },
  { key: 'chores',    label: 'Chores',    render: renderChores },
];
```

Then add this `renderApprovals` function at the end of the file (before the closing of the module — i.e. after `editChore`):

```js
/* ───── Approvals tab ───── */
async function renderApprovals(host) {
  clear(host);
  const { approvals } = await api.get('/api/admin/approvals');

  host.appendChild(el('div', { class: 'row spaced', style: { marginBottom: 'var(--s3)' } }, [
    el('h3', {}, ['Pending approvals']),
    el('span', { class: 'muted' }, [`${approvals.length} waiting`]),
  ]));

  if (approvals.length === 0) {
    host.appendChild(el('p', { class: 'muted' }, ['Nothing to review. Nice.']));
    return;
  }

  const list = el('div', { class: 'stack' },
    approvals.map(a => renderApprovalCard(a, host))
  );
  host.appendChild(list);
}

function renderApprovalCard(a, host) {
  const card = el('div', { class: 'approval-card' }, [
    el('div', { class: 'row spaced' }, [
      el('div', { class: 'row' }, [
        el('div', { class: 'chip', style: { background: a.kid_color || '#0F172A' } }, [a.kid_name[0]]),
        el('div', {}, [
          el('div', { style: { fontWeight: 600 } }, [a.chore_title]),
          el('div', { class: 'muted', style: { fontSize: '0.78rem' } }, [
            `${a.kid_name} · ${a.chore_points} pts · submitted ${a.submitted_at}`
          ]),
        ]),
      ]),
    ]),
    a.photo_url ? el('a', { href: a.photo_url, target: '_blank' }, [
      el('img', { class: 'approval-photo', src: a.photo_url, alt: a.chore_title }),
    ]) : null,
    a.note ? el('div', { class: 'approval-note' }, [a.note]) : null,
    el('div', { class: 'row spaced approval-actions' }, [
      el('button', {
        class: 'btn btn-danger',
        onClick: async () => {
          const note = prompt('Reject reason (optional):') || '';
          if (note === null) return;
          await api.post(`/api/admin/approvals/${a.id}/reject`, { note });
          await renderApprovals(host);
        },
      }, ['Reject']),
      el('div', { class: 'row' }, [
        el('button', {
          class: 'btn btn-ghost',
          onClick: async () => {
            const ptsStr = prompt(`Award how many points? (default ${a.chore_points}):`, String(a.chore_points));
            if (ptsStr === null) return;
            const pts = parseInt(ptsStr, 10);
            if (!Number.isFinite(pts) || pts < 0) { alert('Bad number'); return; }
            await api.post(`/api/admin/approvals/${a.id}/approve`, { points: pts });
            await renderApprovals(host);
          },
        }, ['Approve with…']),
        el('button', {
          class: 'btn btn-primary',
          onClick: async () => {
            await api.post(`/api/admin/approvals/${a.id}/approve`);
            await renderApprovals(host);
          },
        }, [`Approve · +${a.chore_points}`]),
      ]),
    ]),
  ].filter(Boolean));
  return card;
}
```

- [ ] **Step 2: Append CSS for approval cards to `public/css/layouts.css`**

```css
.approval-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  padding: var(--s4);
  margin-bottom: var(--s3);
  display: flex; flex-direction: column; gap: var(--s3);
  box-shadow: var(--shadow-sm);
}
.approval-photo {
  max-width: 100%; max-height: 360px;
  border-radius: var(--r-md);
  display: block;
  object-fit: contain;
  background: var(--card-muted);
}
.approval-note {
  background: var(--card-muted);
  padding: 8px 12px;
  border-radius: var(--r-sm);
  font-size: 0.9rem;
  font-style: italic;
}
.approval-actions { gap: var(--s2); }
```

- [ ] **Step 3: Tests still green**

```bash
cd ~/projects/tally && npm test
```

Expected: PASS — 45 tests.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/admin.js public/css/layouts.css && git commit -m "feat(admin): Approvals tab with photo preview + approve/reject"
```

---

## Task 7: End-to-end smoke + production deploy

- [ ] **Step 1: Full test suite**

```bash
cd ~/projects/tally && npm test
```

Expected: 45 tests pass.

- [ ] **Step 2: Reload PM2 to pick up new code on acutis-box**

```bash
cd ~/projects/tally && pm2 reload tally
```

Wait 2 seconds, then verify:

```bash
sleep 2 && curl -sf --resolve tally.thelopezfamily.org:443:104.21.49.63 https://tally.thelopezfamily.org/api/health
```

Expected: `{"ok":true}`.

- [ ] **Step 3: Live-fire smoke (script)**

```bash
cd ~/projects/tally && node -e "
import('./src/db.js').then(({openDb}) => {
  const db = openDb('./tally.db');
  const counts = db.prepare(\"SELECT status, COUNT(*) c FROM assignments GROUP BY status\").all();
  console.log('Assignment status counts:', counts);
  const submitted = db.prepare(\"SELECT id, chore_id, person_id, photo_path FROM assignments WHERE status='submitted' LIMIT 5\").all();
  console.log('Sample submitted:', submitted);
});
"
```

Use this just to confirm the DB will receive the new states; if there are no submitted rows yet, that's expected — the user creates them by hitting Submit from the kid PWA.

- [ ] **Step 4: Tag the phase release**

```bash
cd ~/projects/tally && git tag v0.3.0-phase3 && git log --oneline -8
```

- [ ] **Step 5: Verify production end-to-end (manual, via the user's phone + admin)**

Open `https://tally.thelopezfamily.org/` as a kid (e.g. Olivia). Confirm:

1. Photo-flagged chore now shows `Photo · +5` button (not "Needs photo" pill).
2. Tapping it opens the camera. Take any photo. After upload, the row turns purple-tinted with "Waiting for parent".
3. Approval-flagged chore shows `Submit · +5`. Tapping moves it to "Waiting for parent".

Then open admin (sign out → sign in as Jeffrey). Confirm:

4. New `Approvals` tab between `Today` and `People`.
5. Pending submissions visible with photo previews + kid avatar + chore title.
6. `Approve · +5` button approves at full points. `Approve with…` prompts for a custom number. `Reject` prompts for a reason and sends it back to pending.
7. After approve, the assignment disappears from the queue and the kid's home shows it as done (struck-through, `+5`).

---

## Self-Review

**Spec coverage (§7 Anti-cheat):**

| Spec point | Task |
|---|---|
| `honor` flow unchanged | Task 3 keeps existing `/done` behavior, `/submit` accepts honor too |
| `photo` flow: tap → camera → capture → submitted | Task 3 (server) + Task 5 (UI camera capture) |
| Photo stored at `./uploads/YYYY-MM/<id>.jpg` | Task 2 (savePhoto) + Task 3 (calls savePhoto with assignment id) |
| `approval` flow: tap → submitted, no photo | Task 3 (server) + Task 5 (UI button) |
| Parent reviews in admin, approve/reject with note | Task 4 (endpoints) + Task 6 (UI) |
| Photos served behind auth | Task 4 `uploadsRoute` — 401 unauthenticated, 403 cross-kid, 200 parent or owner |
| EXIF stripped on upload | Task 2 `savePhoto` uses `.rotate()` (applies orientation then strips) + sharp default re-encodes without EXIF |
| Photo retention (90 day purge) | NOT in this phase — deferred to a future cron. Flagged for follow-up. |

**Placeholder scan:** every step has runnable code or commands. No TBDs.

**Type consistency:**
- `assignment.status` enum used identically across submit / approvals / home: `pending | in-progress | submitted | done | rejected | expired`.
- `req.user.role === 'parent'` check appears in `/submit`, `/uploads`, approvals — consistent.
- `req.user.person_id` (not `id`) is the canonical session-attached identifier — consistent with Phase 1's auth module.
- `photo_url` field name returned by approvals matches what the admin UI consumes.

**One gap fixed inline:** the test file in Task 4 originally mixed `require('node:fs').mkdirSync` and ES imports. Cleaned up to use top-level imports only.

Plan is internally consistent and covers the §7 requirements minus retention purge.

---

## Execution Handoff

Plan complete and saved to [`docs/superpowers/plans/2026-05-26-tally-phase-3-anticheat.md`](2026-05-26-tally-phase-3-anticheat.md). Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task with two-stage review, no context pollution.

**2. Inline Execution** — work through it in this session with checkpoints.

Which approach?
