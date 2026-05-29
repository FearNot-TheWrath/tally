# Tally — Multi-Photo Submission Design

**Date:** 2026-05-29
**Project:** Tally
**Status:** Approved, ready for implementation planning
**Builds on:** Phase 3 (photo/approval anti-cheat), retention sweep, admin approvals + day-review

---

## 1. Summary

Photo chores currently accept exactly one photo (`assignments.photo_path`). This change lets a kid attach up to 3 photos to a single submission, with at least 1 required. Photos move to a dedicated `assignment_photos` table (one row per file), so the single-photo assumption is removed everywhere it currently lives: the submit endpoint, the approvals and day-review displays, and the photo-retention cleanup. The kid captures photos one at a time on their phone, sees thumbnails, and submits all attached photos in a single request.

## 2. Goals

1. **Up to 3 photos per submission, 1 required.** A photo chore can't be submitted with zero photos; it accepts 1, 2, or 3.
2. **One-at-a-time capture.** Tap "Add photo" to take one (camera), see a thumbnail, "Add another" up to 3, then submit once.
3. **Single source of truth.** All photos live in `assignment_photos`; the legacy `photo_path` column is retired.
4. **Reviewers see all photos.** Approvals and day-review render the full set as tappable thumbnails.
5. **Clean lifecycle.** Approve, reject, and the retention sweep remove every photo file and row for the assignment.
6. **No data loss.** Existing single-photo submissions are migrated into the new table.

## 3. Non-goals

- Configurable photo limit (fixed at 3).
- Per-photo notes or captions (one optional note per submission, as today).
- Reordering or deleting individual photos after submit (a reject sends the whole thing back).
- Video or other media.
- Changing the honor/approval flows that don't involve photos.

## 4. Schema

### New migration: `009-assignment-photos.sql`

```sql
CREATE TABLE IF NOT EXISTS assignment_photos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_assignment_photos_assignment ON assignment_photos(assignment_id);

-- Backfill existing single photos, then retire the column as a source of truth.
INSERT INTO assignment_photos (assignment_id, path)
  SELECT id, photo_path FROM assignments WHERE photo_path IS NOT NULL AND photo_path != '';
UPDATE assignments SET photo_path = NULL WHERE photo_path IS NOT NULL;
```

The `assignments.photo_path` column remains in the schema (no risky table recreate) but is no longer read or written after this migration. It will be uniformly NULL.

Note: `ON DELETE CASCADE` is declarative; the app deletes photo rows explicitly (and SQLite foreign-key cascade only fires when `PRAGMA foreign_keys = ON`, which `openDb` sets). Explicit deletes in the app are the primary mechanism so behavior is identical whether or not cascade fires.

## 5. Photo storage: `src/lib/photo.js`

`savePhoto` currently writes `${assignmentId}.jpg`, which collides when one assignment has multiple photos. Change it to take an explicit unique filename component:

```
savePhoto(buffer, assignmentId, rootDir, slot)  // slot: 1..3
  -> writes `${assignmentId}-${slot}.jpg`
```

Each photo for an assignment gets a distinct slot (1, 2, 3), so filenames never collide and re-submission after a reject overwrites cleanly. The resize/EXIF-strip pipeline is unchanged.

## 6. Submit endpoint: `POST /api/assignments/:id/submit`

- Change multer from `upload.single('photo')` to `upload.array('photo', 3)`.
- For a photo chore: require `req.files.length >= 1` (else 400 "At least one photo is required"). Reject if more than 3 (multer enforces the 3 cap; a 4th errors).
- On submit, FIRST clear any existing photos for this assignment (delete files + rows) so a re-submission after a reject doesn't accumulate. Then for each uploaded file, `savePhoto(buffer, id, uploadsDir, slot)` and insert an `assignment_photos` row. Set `status='submitted'`, `submitted_at`, and the optional `note` (single note per submission, unchanged).
- Honor and approval (non-photo) submit paths are unchanged.

## 7. Review + display

### Approvals (`GET /api/admin/approvals`) and Day-review (`GET /api/admin/day-review`)

Each item gains a `photos` array of URLs instead of the single `photo_url`:

```js
photos: ['/api/uploads/2026-05/42-1.jpg', '/api/uploads/2026-05/42-2.jpg']
```

Built by selecting all `assignment_photos` rows for the assignment and mapping each `path` through the existing `relFromUploads` helper. The single `photo_url` field is removed.

### Approve / reject (`POST /api/admin/approvals/:id/{approve,reject}`)

Replace the single `deletePhotoIfPresent(a.photo_path)` with: select all `assignment_photos` rows for the assignment, delete each file, then delete the rows. (Approve and reject both purge photos, same as today.)

### Admin UI (`public/js/pages/admin.js`)

Both the approvals card and the day-review row currently render one `<img>` from `photo_url`. Change to map over `item.photos` and render a horizontal row of up to 3 thumbnails, each wrapped in a link that opens the full image in a new tab (same as today's single-image behavior, just repeated). A small CSS tweak gives the thumbnails a fixed size and gap.

## 8. Retention: `src/lib/retention.js`

`purgeOldPhotos` is filesystem-driven: it scans the `uploads/YYYY-MM/` directories for `*.jpg` files, deletes any whose mtime is older than the window, and then runs a DB statement to null `assignments.photo_path` for the deleted file. Keep the file-scan-and-unlink logic exactly as is (it already handles the new `${id}-${slot}.jpg` files since they live in the same dirs). Only change the DB side: replace the `UPDATE assignments SET photo_path = NULL WHERE photo_path = ?` statement with `DELETE FROM assignment_photos WHERE path = ?`, run with the deleted file path. The column is retired, so no more `photo_path` nulling.

## 9. Kid home UI: `public/js/pages/home.js`

The photo chore action is currently a single file input styled as a "Photo · +N" button that uploads immediately on change. Replace with a small attach-then-submit control for photo chores:

- An "Add photo" button opens the camera (`<input type="file" accept="image/*" capture="environment">`, one file).
- Each captured file is held client-side (kept in a JS array; a thumbnail is shown via `URL.createObjectURL`).
- After 1 photo, an "Add another" affordance appears, disabled once 3 are attached.
- A "Submit · +N" button POSTs all held files at once via `FormData` (`photo` field repeated per file) to the existing submit endpoint. Disabled until at least 1 photo is attached.
- On success, re-render home (the chore moves to "submitted / waiting for parent").

Honor and approval (non-photo) chores keep their existing single-action buttons. Only `anti_cheat === 'photo'` chores get the multi-attach control.

## 10. Tests

### Extend `tests/routes-home.test.js` (or the photo submit tests)

- Submitting a photo chore with 2 photos creates 2 `assignment_photos` rows and sets status `submitted`.
- Submitting with 0 photos returns 400.
- Submitting more than 3 is rejected (multer cap).
- Re-submitting after a reject clears the prior photos (no accumulation; old files/rows gone).

### Extend `tests/routes-admin-approvals.test.js` (or approvals/day-review tests)

- Approvals payload returns a `photos` array with all photo URLs.
- Approve deletes all `assignment_photos` rows for the assignment.
- Reject deletes all `assignment_photos` rows for the assignment.

### New/extend retention test

- The sweep, after unlinking an aged file, deletes the matching `assignment_photos` row (path-based), mirroring how the existing test asserts `photo_path` was nulled.

### Migration test

- After migration 009, `assignment_photos` exists; a pre-seeded `photo_path` is backfilled into it and the column is nulled.

Existing tests: 179. After this feature: ~189.

## 11. Tech notes

- Multer `upload.array('photo', 3)` puts files on `req.files` (array). The field name stays `photo`; the client appends it once per file.
- `savePhoto` slotting (`-1`, `-2`, `-3`) keeps filenames deterministic per assignment, so a reject-then-resubmit overwrites rather than orphaning files; the submit handler also explicitly deletes prior rows/files first, so both mechanisms agree.
- The legacy `photo_path` column is left in place (NULL) rather than dropped to avoid an `assignments` table recreate; it can be dropped in a later cleanup if desired.
- Photos are still served through the existing authenticated `/api/uploads/...` route; no change there.
- Client holds raw `File` objects until submit, so there is no partial server-side state and no extra "append photo" endpoint.

## 12. Acceptance test (manual, post-deploy)

1. As a kid, open a photo chore. Tap "Add photo", take one — a thumbnail appears, Submit enables.
2. Tap "Add another" twice, take two more (3 total). "Add another" disables at 3.
3. Submit. The chore moves to "waiting for parent".
4. As parent, open Approvals (or Day-review) — see all 3 thumbnails; tap one to view full size.
5. Approve. The chore completes and all 3 photo files are deleted from disk.
6. Submit another photo chore with just 1 photo — works (1 is the minimum).
7. Reject it, then re-submit with 2 different photos — the old photo is gone, the 2 new ones show.
8. Confirm an old (pre-migration) submission's photo still displays via the backfilled row.
