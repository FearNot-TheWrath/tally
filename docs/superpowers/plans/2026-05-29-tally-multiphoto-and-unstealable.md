# Tally — Multi-Photo Submission + Unstealable Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two bundled changes — (A) let a kid attach up to 3 photos (1 required) to a photo-chore submission, stored in a new `assignment_photos` table; and (B) rename the `is_school_work` chore flag to `unstealable` since not all unstealable chores are school work.

**Architecture:** (A) New `assignment_photos` table (one row per file) replaces the single `assignments.photo_path` column as the source of truth; the submit endpoint takes `upload.array('photo', 3)`, the kid attaches photos one at a time client-side and submits all at once, and approvals/day-review/retention operate on the table. (B) A `RENAME COLUMN` migration plus mechanical identifier/label updates; behavior (only the flag's name) is unchanged.

**Tech Stack:** Node 20 ESM, Express 5, better-sqlite3, multer, sharp, vanilla JS. No new dependencies.

**Spec (multi-photo):** [`docs/superpowers/specs/2026-05-29-tally-multi-photo-submission-design.md`](../specs/2026-05-29-tally-multi-photo-submission-design.md)

**Unstealable rename:** approved in conversation (no separate spec) — one flag, controls stealing only; a future school-deadline feature will get its own flag.

---

## File Structure

```
~/projects/tally/
├── src/
│   ├── migrations/
│   │   ├── 009-assignment-photos.sql       NEW (multi-photo)
│   │   └── 010-rename-unstealable.sql      NEW (rename)
│   ├── lib/
│   │   ├── photo.js                        MODIFY: savePhoto slot param
│   │   └── retention.js                    MODIFY: delete assignment_photos rows by path
│   └── routes/
│       ├── home.js                         MODIFY: submit upload.array + multi-insert; steal query rename
│       └── admin/
│           ├── approvals.js                MODIFY: photos[] + delete-all on approve/reject
│           ├── day-review.js               MODIFY: photos[]
│           └── chores.js                   MODIFY: ALLOWED_FIELDS rename
├── public/
│   ├── js/pages/
│   │   ├── home.js                         MODIFY: multi-attach photo UI
│   │   └── admin.js                        MODIFY: thumbnail gallery; chore modal/list/settings rename
│   └── css/layouts.css                     MODIFY: thumbnail row style
└── tests/
    ├── lib-photo.test.js                   MODIFY: slot filename
    ├── routes-submit.test.js               MODIFY: multi-photo + assignment_photos asserts
    ├── routes-admin-approvals.test.js      MODIFY: photos[] + delete-all
    ├── routes-admin-day-review.test.js     MODIFY: photos[]
    ├── lib-retention.test.js               MODIFY: assignment_photos row delete
    ├── routes-steal.test.js                MODIFY: unstealable column
    ├── routes-admin-chores.test.js         MODIFY: unstealable field
    ├── lib-points.test.js                  MODIFY: unstealable column in seed
    └── auth.test.js                        MODIFY: schema column assertion
```

---

## Task 1: Migration 009 — assignment_photos table + backfill

**Files:**
- Create: `src/migrations/009-assignment-photos.sql`

- [ ] **Step 1: Create the migration**

```sql
CREATE TABLE IF NOT EXISTS assignment_photos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_assignment_photos_assignment ON assignment_photos(assignment_id);

INSERT INTO assignment_photos (assignment_id, path)
  SELECT id, photo_path FROM assignments WHERE photo_path IS NOT NULL AND photo_path != '';
UPDATE assignments SET photo_path = NULL WHERE photo_path IS NOT NULL;
```

- [ ] **Step 2: Verify it runs and backfills**

```bash
cd ~/projects/tally && node -e "
import('./src/db.js').then(({runMigrations}) => import('better-sqlite3').then(({default:D}) => {
  const db = new D(':memory:'); runMigrations(db);
  // seed a legacy single-photo row by inserting then simulating old state is unnecessary; just confirm table exists
  console.log('table:', db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='assignment_photos'\").get());
}));"
```

Expected: `table: { name: 'assignment_photos' }`.

- [ ] **Step 3: Run the full suite (additive; nothing consumes the table yet)**

```bash
cd ~/projects/tally && npm test
```

Expected: 179 tests pass.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add src/migrations/009-assignment-photos.sql && git commit -m "feat(schema): migration 009 assignment_photos table + backfill"
```

---

## Task 2: `savePhoto` unique filenames per slot

**Files:**
- Modify: `src/lib/photo.js`
- Modify: `tests/lib-photo.test.js`

- [ ] **Step 1: Update the failing test first**

In `tests/lib-photo.test.js`, the existing test asserts the path ends `/42.jpg`. Change it to pass a slot and expect `/42-1.jpg`. Find:

```js
    assert.match(path, /\d{4}-\d{2}\/42\.jpg$/);
```

Replace the relevant call + assertion so the `savePhoto` call passes a slot of `1` and the assertion becomes:

```js
    assert.match(path, /\d{4}-\d{2}\/42-1\.jpg$/);
```

(The `savePhoto(buffer, 42, root)` call in that test becomes `savePhoto(buffer, 42, root, 1)`.)

- [ ] **Step 2: Run it to verify it fails**

```bash
cd ~/projects/tally && node --test tests/lib-photo.test.js
```

Expected: FAIL — current code writes `42.jpg`, not `42-1.jpg`.

- [ ] **Step 3: Modify `src/lib/photo.js`**

Change the signature and filename. Find:

```js
export async function savePhoto(buffer, assignmentId, rootDir = './uploads') {
```
to:
```js
export async function savePhoto(buffer, assignmentId, rootDir = './uploads', slot = 1) {
```

And change:
```js
  const path = join(dir, `${assignmentId}.jpg`);
```
to:
```js
  const path = join(dir, `${assignmentId}-${slot}.jpg`);
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && node --test tests/lib-photo.test.js && npm test
```

Expected: lib-photo passes; full suite still 179 (other photo tests use the submit endpoint, updated in Task 3).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/lib/photo.js tests/lib-photo.test.js && git commit -m "feat(photo): savePhoto takes a slot for unique per-photo filenames"
```

---

## Task 3: Submit endpoint accepts up to 3 photos

**Files:**
- Modify: `src/routes/home.js`
- Modify: `tests/routes-submit.test.js`

- [ ] **Step 1: Update + add tests in `tests/routes-submit.test.js`**

The file already imports `sharp` and has a `jpeg()` helper returning a JPEG buffer, plus `seedChore`, `seedAssignment`, `loginKid`, and uses `mkdtempSync` for an uploads dir.

(a) The existing "without a photo rejects with 400" test asserts `/photo required/i`. Change that regex to `/at least one photo/i`.

(b) The existing "WITH photo stores file and sets submitted" test asserts `row.photo_path`. Replace its post-submit assertions (the block checking `row.photo_path ... endsWith(\`${aId}.jpg\`)` and `existsSync(row.photo_path)`) with assertions against `assignment_photos`:

```js
    assert.equal(row.status, 'submitted');
    const photos = db.prepare('SELECT * FROM assignment_photos WHERE assignment_id = ?').all(aId);
    assert.equal(photos.length, 1);
    assert.ok(existsSync(photos[0].path));
    assert.ok(photos[0].path.endsWith(`${aId}-1.jpg`));
```

(c) Add two new tests (place after the existing photo test, inside the same `mkdtemp`/uploadsDir pattern it uses — mirror that test's setup for the uploads root):

```js
test('submit on photo chore accepts up to 3 photos', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tally-submit-'));
  try {
    const db = freshDb();
    const kid = seedKid(db, 'K');
    const cId = seedChore(db, 'photo', kid);
    const aId = seedAssignment(db, cId, kid);
    const agent = await loginKid(freshApp(db, { uploadsDir: root }), kid);
    const res = await agent.post(`/api/assignments/${aId}/submit`)
      .attach('photo', await jpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' })
      .attach('photo', await jpeg(), { filename: 'b.jpg', contentType: 'image/jpeg' });
    assert.equal(res.status, 200);
    const photos = db.prepare('SELECT * FROM assignment_photos WHERE assignment_id = ?').all(aId);
    assert.equal(photos.length, 2);
    for (const p of photos) assert.ok(existsSync(p.path));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('re-submitting a photo chore clears prior photos', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tally-submit-'));
  try {
    const db = freshDb();
    const kid = seedKid(db, 'K');
    const cId = seedChore(db, 'photo', kid);
    const aId = seedAssignment(db, cId, kid);
    const agent = await loginKid(freshApp(db, { uploadsDir: root }), kid);
    await agent.post(`/api/assignments/${aId}/submit`)
      .attach('photo', await jpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    const first = db.prepare('SELECT path FROM assignment_photos WHERE assignment_id = ?').all(aId);
    // simulate a reject returning it to pending
    db.prepare("UPDATE assignments SET status = 'pending' WHERE id = ?").run(aId);
    await agent.post(`/api/assignments/${aId}/submit`)
      .attach('photo', await jpeg(), { filename: 'c.jpg', contentType: 'image/jpeg' });
    const after = db.prepare('SELECT path FROM assignment_photos WHERE assignment_id = ?').all(aId);
    assert.equal(after.length, 1);
    assert.equal(existsSync(first[0].path), false); // old file removed
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

Ensure `rmSync`, `mkdtempSync`, `tmpdir`, `join`, `existsSync` are imported in the test file (the existing photo test already imports them; reuse).

Also confirm the file has a `seedKid` helper; if the existing tests use a differently-named kid seeder, match that name. (Use whatever the file already defines for seeding a kid + photo chore + assignment.)

- [ ] **Step 2: Run to verify failures**

```bash
cd ~/projects/tally && node --test tests/routes-submit.test.js
```

Expected: FAIL — endpoint still single-photo, writes photo_path, new tests error.

- [ ] **Step 3: Modify `src/routes/home.js`**

(a) Add an fs import at the top (after the existing imports):

```js
import { unlinkSync } from 'node:fs';
```

(b) Change the submit route's multer middleware. Find:

```js
  r.post('/assignments/:id/submit', requireAnyAuth, upload.single('photo'), (req, res) => {
```
to:
```js
  r.post('/assignments/:id/submit', requireAnyAuth, upload.array('photo', 3), (req, res) => {
```

(c) Replace the `// anti_cheat === 'photo'` block at the end of `doSubmit`. Find:

```js
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
      notifyWall();
    })
    .catch(err => res.status(400).json({ error: err.message }));
}
```

with:

```js
  // anti_cheat === 'photo'
  const files = req.files || [];
  if (files.length === 0) return res.status(400).json({ error: 'At least one photo is required' });

  // Clear any prior photos for this assignment (re-submit after a reject).
  const prior = db.prepare('SELECT path FROM assignment_photos WHERE assignment_id = ?').all(req.params.id);
  for (const p of prior) { try { unlinkSync(p.path); } catch { /* gone already */ } }
  db.prepare('DELETE FROM assignment_photos WHERE assignment_id = ?').run(req.params.id);

  return Promise.all(files.map((f, i) => savePhoto(f.buffer, Number(req.params.id), uploadsDir, i + 1)))
    .then(paths => {
      const ins = db.prepare('INSERT INTO assignment_photos (assignment_id, path) VALUES (?, ?)');
      for (const p of paths) ins.run(req.params.id, p);
      db.prepare(`
        UPDATE assignments
        SET status = 'submitted', submitted_at = datetime('now'),
            note = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(req.body?.note || '', req.params.id);
      res.json({ ok: true, status: 'submitted' });
      notifyWall();
    })
    .catch(err => res.status(400).json({ error: err.message }));
}
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && node --test tests/routes-submit.test.js && npm test
```

Expected: submit tests pass; full suite green except approvals/day-review/retention tests that still expect `photo_url`/`photo_path` (fixed in Tasks 4-5). If those fail now, that is expected at this step; proceed.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/routes/home.js tests/routes-submit.test.js && git commit -m "feat(submit): accept up to 3 photos, store in assignment_photos, clear on resubmit"
```

---

## Task 4: Approvals + day-review return photos[]; purge all on approve/reject

**Files:**
- Modify: `src/routes/admin/approvals.js`
- Modify: `src/routes/admin/day-review.js`
- Modify: `tests/routes-admin-approvals.test.js`
- Modify: `tests/routes-admin-day-review.test.js`

- [ ] **Step 1: Modify `src/routes/admin/approvals.js`**

(a) In the `GET /approvals` handler, the rows are mapped to objects including `photo_url: row.photo_path ? ... : null`. Replace that mapping so each row gets a `photos` array. After the `.all(...)` that fetches rows, map each row:

```js
    const withPhotos = rows.map(row => ({
      ...row,
      photos: db.prepare('SELECT path FROM assignment_photos WHERE assignment_id = ? ORDER BY id').all(row.id)
        .map(p => `/api/uploads/${relFromUploads(p.path)}`),
    }));
```
and return `withPhotos` instead of `rows`. Remove the old `photo_url` field and the `photo_path` selection from the SELECT (or leave the column unselected). Ensure the response shape exposes `photos` (and no longer `photo_url`).

(b) In `approve` and `reject`, replace `deletePhotoIfPresent(a.photo_path);` (both handlers) and remove `photo_path = NULL,` from both UPDATE statements. Add a helper and call it in both:

```js
function deleteAllPhotos(db, assignmentId) {
  const rows = db.prepare('SELECT path FROM assignment_photos WHERE assignment_id = ?').all(assignmentId);
  for (const r of rows) { try { unlinkSync(r.path); } catch { /* gone */ } }
  db.prepare('DELETE FROM assignment_photos WHERE assignment_id = ?').run(assignmentId);
}
```

In each handler, after fetching `a`, call `deleteAllPhotos(db, a.id);` (replacing the `deletePhotoIfPresent(a.photo_path)` line), and delete the `photo_path = NULL,` line from the UPDATE. `unlinkSync` is already imported in this file (used by `deletePhotoIfPresent`); you may remove `deletePhotoIfPresent` if now unused.

- [ ] **Step 2: Modify `src/routes/admin/day-review.js`**

The GET handler maps rows with `photo_url: row.photo_path ? ... : null`. Replace with a `photos` array exactly as in approvals (use that file's `relFromUploads` equivalent — day-review has its own helper; reuse it):

```js
      photos: db.prepare('SELECT path FROM assignment_photos WHERE assignment_id = ? ORDER BY id').all(row.id)
        .map(p => `/api/uploads/${relFromUploads(p.path)}`),
```
and drop the `photo_url` field. (Match the existing helper name used in day-review.js for the uploads-relative path.)

- [ ] **Step 3: Update tests**

In `tests/routes-admin-approvals.test.js` and `tests/routes-admin-day-review.test.js`: any assertion on `photo_url` becomes an assertion on `photos` (an array). Where a test seeds a photo via `photo_path` on the assignment, change it to insert an `assignment_photos` row instead:

```js
db.prepare("INSERT INTO assignment_photos (assignment_id, path) VALUES (?, ?)").run(aId, '/abs/uploads/2026-05/' + aId + '-1.jpg');
```
and assert e.g. `assert.equal(res.body.<items>[0].photos.length, 1)`. For approve/reject tests that asserted the photo file was deleted or `photo_path` nulled, assert instead that `assignment_photos` rows for that assignment are gone:
```js
assert.equal(db.prepare('SELECT COUNT(*) c FROM assignment_photos WHERE assignment_id = ?').get(aId).c, 0);
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: approvals + day-review tests pass. Retention test may still fail (Task 5).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/routes/admin/approvals.js src/routes/admin/day-review.js tests/routes-admin-approvals.test.js tests/routes-admin-day-review.test.js && git commit -m "feat(review): expose photos[] and purge all assignment photos on approve/reject"
```

---

## Task 5: Retention deletes assignment_photos rows by path

**Files:**
- Modify: `src/lib/retention.js`
- Modify: `tests/lib-retention.test.js`

- [ ] **Step 1: Update the test**

In `tests/lib-retention.test.js`, the test "purgeOldPhotos nulls photo_path on assignment row when file is purged" seeds an assignment with `photo_path` and asserts it becomes null. Change it to seed an `assignment_photos` row pointing at the aged file and assert the row is deleted:

```js
    // after creating the aged file at filePath and the assignment:
    db.prepare("INSERT INTO assignment_photos (assignment_id, path) VALUES (?, ?)").run(7, filePath);
    purgeOldPhotos(db, root, 5);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM assignment_photos WHERE path = ?').get(filePath).c, 0);
```
(Rename the test to reflect it deletes the assignment_photos row. Keep the file-aging via `utimesSync` exactly as is.)

- [ ] **Step 2: Run to verify failure**

```bash
cd ~/projects/tally && node --test tests/lib-retention.test.js
```

Expected: FAIL — current code nulls `photo_path`, doesn't touch `assignment_photos`.

- [ ] **Step 3: Modify `src/lib/retention.js`**

Replace the DB statement. Find:

```js
  const nullStmt = db.prepare(
    "UPDATE assignments SET photo_path = NULL, updated_at = datetime('now') WHERE photo_path = ?"
  );
```
with:
```js
  const delStmt = db.prepare(
    'DELETE FROM assignment_photos WHERE path = ?'
  );
```

And find the deletion call:
```js
          unlinkSync(file);
          nullStmt.run(file);
          deleted++;
```
replace with:
```js
          unlinkSync(file);
          delStmt.run(file);
          deleted++;
```

Update the JSDoc comment that says "Also nulls assignments.photo_path..." to "Also deletes assignment_photos rows for any purged file."

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && npm test
```

Expected: full suite green — 184 tests (179 + 5 new from Tasks 2-3; retention/approvals updated in place). The exact count may differ slightly; the requirement is 0 failures.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/lib/retention.js tests/lib-retention.test.js && git commit -m "feat(retention): purge assignment_photos rows by path instead of nulling photo_path"
```

---

## Task 6: Admin UI photo thumbnails

**Files:**
- Modify: `public/js/pages/admin.js`
- Modify: `public/css/layouts.css`

- [ ] **Step 1: Approvals card thumbnails**

In `public/js/pages/admin.js`, the approvals card renders a single image:
```js
    a.photo_url ? el('a', { href: a.photo_url, target: '_blank' }, [
      el('img', { class: 'approval-photo', src: a.photo_url, alt: a.chore_title }),
    ]) : null,
```
Replace with a row of thumbnails from `a.photos`:
```js
    (a.photos && a.photos.length)
      ? el('div', { class: 'photo-thumbs' }, a.photos.map(url =>
          el('a', { href: url, target: '_blank' }, [
            el('img', { class: 'photo-thumb', src: url, alt: a.chore_title }),
          ])))
      : null,
```

- [ ] **Step 2: Day-review row thumbnails**

In the day-review row renderer, the single image:
```js
      it.photo_url ? el('a', { href: it.photo_url, target: '_blank' }, [
        el('img', { class: 'review-photo', src: it.photo_url, alt: it.chore_title }),
      ]) : null,
```
Replace with:
```js
      (it.photos && it.photos.length)
        ? el('div', { class: 'photo-thumbs' }, it.photos.map(url =>
            el('a', { href: url, target: '_blank' }, [
              el('img', { class: 'photo-thumb', src: url, alt: it.chore_title }),
            ])))
        : null,
```

- [ ] **Step 3: Add CSS to `public/css/layouts.css`**

```css
.photo-thumbs { display: flex; flex-wrap: wrap; gap: 8px; }
.photo-thumbs .photo-thumb {
  width: 96px; height: 96px;
  object-fit: cover;
  border-radius: var(--r-sm);
  background: var(--card-muted);
}
```

- [ ] **Step 4: Run tests + syntax check**

```bash
cd ~/projects/tally && node --check public/js/pages/admin.js && npm test
```

Expected: admin.js parses; suite green (client-only change).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/admin.js public/css/layouts.css && git commit -m "feat(admin): render up to 3 photo thumbnails in approvals + day-review"
```

---

## Task 7: Kid home multi-attach photo control

**Files:**
- Modify: `public/js/pages/home.js`

- [ ] **Step 1: Replace the photo action block in `renderTask`**

Find the `} else if (a.anti_cheat === 'photo') {` block (the `el('label', { class: 'btn btn-primary btn-done photo-btn' }, [...])` single-file uploader) and replace the whole `else if` body with a multi-attach control:

```js
  } else if (a.anti_cheat === 'photo') {
    const files = [];
    const thumbs = el('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, []);
    const submitBtn = el('button', { class: 'btn btn-primary btn-done' }, [`Submit · +${a.display_points}`]);
    const addBtn = el('label', { class: 'btn btn-ghost btn-sm photo-btn' }, [
      'Add photo',
      el('input', {
        type: 'file', accept: 'image/*', capture: 'environment',
        style: { display: 'none' },
        onChange: (e) => {
          const f = e.target.files[0];
          e.target.value = '';
          if (!f || files.length >= 3) return;
          files.push(f);
          thumbs.appendChild(el('img', {
            src: URL.createObjectURL(f),
            style: { width: '40px', height: '40px', objectFit: 'cover', borderRadius: 'var(--r-sm)' },
          }));
          sync();
        },
      }),
    ]);
    function sync() {
      submitBtn.disabled = files.length === 0;
      addBtn.style.display = files.length >= 3 ? 'none' : '';
    }
    submitBtn.onclick = async () => {
      if (files.length === 0) return;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Uploading…';
      const fd = new FormData();
      for (const f of files) fd.append('photo', f);
      try {
        const res = await fetch(`/api/assignments/${a.id}/submit`, {
          method: 'POST', credentials: 'same-origin', body: fd,
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || res.statusText); }
        renderHome(root);
      } catch (err) {
        alert('Upload failed: ' + err.message);
        submitBtn.disabled = false;
        submitBtn.textContent = `Submit · +${a.display_points}`;
      }
    };
    sync();
    action = el('div', { class: 'row', style: { gap: '6px', alignItems: 'center', flexWrap: 'wrap' } }, [thumbs, addBtn, submitBtn]);
  }
```

This keeps the `.photo-btn` class (existing styles still apply). The kid attaches 1-3 photos (each shows a 40px thumbnail), "Add photo" hides at 3, and Submit is disabled until at least one is attached.

- [ ] **Step 2: Syntax check + tests**

```bash
cd ~/projects/tally && node --check public/js/pages/home.js && npm test
```

Expected: parses; suite green (client-only).

- [ ] **Step 3: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/home.js && git commit -m "feat(home): attach up to 3 photos one at a time, submit together"
```

---

## Task 8: Migration 010 — rename is_school_work to unstealable

**Files:**
- Create: `src/migrations/010-rename-unstealable.sql`

- [ ] **Step 1: Create the migration**

```sql
ALTER TABLE chores RENAME COLUMN is_school_work TO unstealable;
```

- [ ] **Step 2: Verify the rename (and that the CHECK constraint follows)**

```bash
cd ~/projects/tally && node -e "
import('better-sqlite3').then(async ({default:D}) => {
  const { runMigrations } = await import('./src/db.js');
  const db = new D(':memory:'); runMigrations(db);
  const cols = db.prepare('PRAGMA table_info(chores)').all().map(c => c.name);
  console.log('has unstealable:', cols.includes('unstealable'), '| has is_school_work:', cols.includes('is_school_work'));
  db.prepare(\"INSERT INTO chores (title, unstealable) VALUES ('T', 1)\").run();
  console.log('insert with unstealable=1: OK');
});"
```

Expected: `has unstealable: true | has is_school_work: false` and `insert ... OK`.

- [ ] **Step 3: Run the suite (expect failures in steal/chores/points/auth tests until Task 9)**

```bash
cd ~/projects/tally && npm test 2>&1 | tail -5
```

Expected: failures referencing `is_school_work` (those tests fixed in Task 9). Proceed.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add src/migrations/010-rename-unstealable.sql && git commit -m "feat(schema): migration 010 rename chores.is_school_work to unstealable"
```

---

## Task 9: Rename is_school_work → unstealable across code + tests

**Files:**
- Modify: `src/routes/home.js`, `src/routes/admin/chores.js`, `public/js/pages/admin.js`
- Modify: `tests/routes-steal.test.js`, `tests/routes-admin-chores.test.js`, `tests/lib-points.test.js`, `tests/auth.test.js`

- [ ] **Step 1: `src/routes/home.js` — steal query + guard**

Find in the stealable query:
```js
        AND c.is_school_work = 0
```
→
```js
        AND c.unstealable = 0
```

Find in the steal handler:
```js
      SELECT a.*, c.is_school_work
```
→
```js
      SELECT a.*, c.unstealable
```

And:
```js
    if (a.is_school_work) return res.status(400).json({ error: 'School work cannot be stolen' });
```
→
```js
    if (a.unstealable) return res.status(400).json({ error: 'This chore cannot be stolen' });
```

- [ ] **Step 2: `src/routes/admin/chores.js` — ALLOWED_FIELDS**

Find `'is_school_work'` in the `ALLOWED_FIELDS` array and change it to `'unstealable'`.

- [ ] **Step 3: `public/js/pages/admin.js` — modal, list badge, settings copy**

(a) New-chore default. Find:
```js
    title: '', points: 5, weight: 3, is_school_work: 0,
```
→
```js
    title: '', points: 5, weight: 3, unstealable: 0,
```

(b) Checkbox in the chore modal. Find:
```js
          checked: data.is_school_work === 1,
          onChange: e => { data.is_school_work = e.target.checked ? 1 : 0; },
```
→
```js
          checked: data.unstealable === 1,
          onChange: e => { data.unstealable = e.target.checked ? 1 : 0; },
```
and change the adjacent label text "School work — cannot be stolen by siblings" to "Unstealable — siblings can't steal it".

(c) Chores-list badge. Find:
```js
${c.is_school_work ? ' · (school)' : ''}
```
→
```js
${c.unstealable ? ' · (no steal)' : ''}
```

(d) Settings hint copy. Find:
```js
    "Time of day after which kids can claim siblings' pending non-school chores.",
```
→
```js
    "Time of day after which kids can claim siblings' pending stealable chores.",
```

- [ ] **Step 4: Update tests**

(a) `tests/routes-steal.test.js`: the `seedChore` helper inserts `is_school_work`. Change the INSERT column to `unstealable`. The test "steal returns 400 for school work" asserts `res.body.error` matches `/school/i` — change that to `/cannot be stolen/i` (or `/steal/i`). Rename test titles mentioning "school" to "unstealable" (cosmetic but do it). The "stealable excludes school work" test seeds with the flag = 1; keep the seed but it now sets `unstealable`.

(b) `tests/routes-admin-chores.test.js`: the POST/PATCH test sends `is_school_work: 0` / `is_school_work: 1` and asserts `c.body.chore.is_school_work`. Change all four to `unstealable`.

(c) `tests/lib-points.test.js`: the seed `INSERT INTO chores (title, weight, is_school_work, recurs) ...` → `unstealable`.

(d) `tests/auth.test.js`: the test asserting `choreCols.includes('is_school_work')` → `choreCols.includes('unstealable')`. Update the test title if it names the column.

- [ ] **Step 5: Run the full suite**

```bash
cd ~/projects/tally && npm test
```

Expected: 0 failures. (Same total as after Task 5 — these are renames, not new tests.)

- [ ] **Step 6: Commit**

```bash
cd ~/projects/tally && git add src/routes/home.js src/routes/admin/chores.js public/js/pages/admin.js tests/routes-steal.test.js tests/routes-admin-chores.test.js tests/lib-points.test.js tests/auth.test.js && git commit -m "refactor: rename is_school_work to unstealable across code and tests"
```

---

## Task 10: Deploy + tag

- [ ] **Step 1: Final full suite**

```bash
cd ~/projects/tally && npm test
```

Expected: 0 failures (~184 tests).

- [ ] **Step 2: Back up the DB (migrations 009 + 010 run on next boot), reload, verify**

```bash
cd ~/projects/tally && cp tally.db "tally.db.bak-pre-multiphoto-$(date +%Y%m%d-%H%M%S)" && pm2 reload tally && sleep 3 && curl -sf http://localhost:3012/api/health && echo " <- health"
```

Expected: `{"ok":true}`.

- [ ] **Step 3: Verify migrations applied + data intact**

```bash
cd ~/projects/tally && node -e "
import('better-sqlite3').then(({default:D}) => {
  const db = new D('./tally.db');
  const m = db.prepare('SELECT name FROM _migrations ORDER BY name').all().map(r=>r.name);
  console.log('009 applied:', m.includes('009-assignment-photos.sql'));
  console.log('010 applied:', m.includes('010-rename-unstealable.sql'));
  const cols = db.prepare('PRAGMA table_info(chores)').all().map(c=>c.name);
  console.log('unstealable col:', cols.includes('unstealable'));
  console.log('assignment_photos backfilled rows:', db.prepare('SELECT COUNT(*) c FROM assignment_photos').get().c);
});"
```

Expected: both migrations applied, `unstealable` column present.

- [ ] **Step 4: Tag**

```bash
cd ~/projects/tally && git tag v0.10.0-multiphoto-unstealable && git tag -l 'v*' | tail -4
```

---

## Self-Review

**Spec coverage (multi-photo):**

| Spec section | Task(s) |
|---|---|
| §4 Schema (assignment_photos + backfill) | Task 1 |
| §5 savePhoto slot | Task 2 |
| §6 Submit upload.array + clear-prior | Task 3 |
| §7 Approvals/day-review photos[] + purge | Task 4 |
| §8 Retention by path | Task 5 |
| §7 Admin thumbnails | Task 6 |
| §9 Kid multi-attach UI | Task 7 |
| §10 Tests | Tasks 2-5 (update existing + add new) |
| §12 Acceptance | Task 10 + manual |

**Unstealable rename coverage:** migration (Task 8), code + tests (Task 9). All grep'd references covered: home.js (steal query + guard), admin/chores.js (ALLOWED_FIELDS), admin.js (default, checkbox, badge, settings copy), tests (steal, admin-chores, points, auth).

**Placeholder scan:** Every code step has concrete before/after. Test-update steps describe exact assertions to change. No TBDs.

**Type/identifier consistency:**
- `assignment_photos(assignment_id, path)` consistent across migration, submit, approvals, day-review, retention, tests.
- `savePhoto(buffer, id, dir, slot)` signature consistent (Task 2 defines, Task 3 uses with `i + 1`).
- `photos` array field consistent between approvals/day-review routes (Task 4) and admin UI (Task 6).
- `unstealable` column/field consistent across migration (Task 8), all source (Task 9 step 1-3), and tests (Task 9 step 4).

Ordering note: migration 009 (photos) precedes 010 (rename) numerically and in task order. Tasks 3-5 leave some existing tests red until their sibling step updates them; Task 5 ends green for the photo half, Task 9 ends green for the rename half.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-29-tally-multiphoto-and-unstealable.md`. 10 tasks. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks
**2. Inline Execution** — direct in this session

Which approach?
