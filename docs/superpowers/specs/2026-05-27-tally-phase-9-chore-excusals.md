# Tally — Phase 9 (Chore Excusals) Design

**Date:** 2026-05-27
**Project:** Tally
**Status:** Approved, ready for implementation planning
**Builds on:** Phase 6a (streaks), Phase 2a (weighted points), Phase 5 (SSE wall)

---

## 1. Summary

A parent can excuse a single chore for a single day when circumstances make it impossible or unnecessary (e.g. "walk the dogs" while a dog has a hurt leg). The excused assignment is removed from streak math, the weekly points denominator, and the at-risk warning, so the assigned kid gets a clean pass that neither helps nor hurts their streak, goals, or pay. The kid still sees the chore on their phone, greyed out with an "Excused" tag and the reason, so they know they were let off and why.

## 2. Goals

1. **Per-assignment, per-day excusal** — excuse one kid's instance of one chore on one day.
2. **Zero impact on streak** — an excused chore drops out of the "all chores done" check.
3. **Zero impact on goals/pay** — the excused chore's weight leaves the weekly denominator.
4. **No false at-risk warning** — an excused chore does not trigger the "finish your chores" streak warning.
5. **Transparent to the kid** — the chore shows as excused with the reason, not silently removed.
6. **Reversible** — the parent can undo an excusal (mistake, or the situation resolves same-day).

## 3. Non-goals (Phase 9)

- Ongoing or multi-day excusals (one day at a time; re-excuse tomorrow if still needed). The whole-kid date-range freeze from Phase 6a already covers extended absences.
- Kid-initiated excuse requests (parent-only action).
- Excusing bonus chores (bonuses are never required, so excusing them is meaningless).
- Excuse history / audit log.
- Excusing a chore for every kid at once (excuse each assignment individually).

## 4. Mechanism

An excused assignment uses the existing columns:
- `assignments.status = 'excused'` — a new terminal status alongside `done`, `expired`, `rejected`.
- `assignments.note` — holds the reason text (reused; an excused chore never goes through the approval/reject flow, so no collision).

**No migration needed.** `status` is already free-text TEXT; `note` already exists.

`'excused'` is treated as terminal everywhere `done`/`expired`/`rejected` are: it is excluded from "active" and "overdue" filters, from streak qualification, and from the points denominator.

## 5. Endpoints

New file `src/routes/admin/assignments.js` (parent-only), mounted at `/api/admin`. This keeps `today.js` focused on its read view and gives assignment mutations their own home, mirroring how `approvals.js` owns approve/reject.

- **`POST /api/admin/assignments/:id/excuse`** — body `{ note }` (string, optional). Sets the assignment's `status='excused'` and `note` to the provided reason (or a default `'Excused by parent'` if blank). Only operates on assignments whose chore `kind != 'bonus'`. Returns `{ ok: true }`. Calls `notifyWall()` after the response.
- **`POST /api/admin/assignments/:id/unexcuse`** — reverts `status='pending'`, sets `note=NULL`. Returns `{ ok: true }`. Calls `notifyWall()`. Only acts if the assignment is currently `excused` (otherwise 409).

Both require `requireRole('parent')`.

## 6. Streak math changes (`src/lib/streak.js`)

**`dayQualifies`** — current query counts total non-bonus assignments and how many are done:

```sql
SELECT COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN a.status = 'done' THEN 1 ELSE 0 END), 0) AS done
FROM assignments a JOIN chores c ON c.id = a.chore_id
WHERE a.person_id = ? AND a.due_date = ? AND c.kind != 'bonus'
```

Add `AND a.status != 'excused'`. Result: an excused chore is neither in `total` nor `done`. A day with `[done, excused]` → `total=1, done=1` → qualifies. A day with only `[excused]` → `total=0` → vacuously qualifies (no failure possible).

**`streakAtRisk`** — current query finds a pending non-bonus chore for today:

```sql
SELECT 1 FROM assignments a JOIN chores c ON c.id = a.chore_id
WHERE a.person_id = ? AND a.due_date = ?
  AND a.status != 'done' AND c.kind != 'bonus' LIMIT 1
```

Add `AND a.status != 'excused'` so an excused chore does not count as an outstanding task and does not trigger the at-risk warning.

## 7. Points math changes (`src/lib/points.js`)

**`calcWeekPoints` denominator** — the materialized-rows query (`matRows`) currently sums weight for the kid's non-bonus assignments in the week. Add `AND a.status != 'excused'` so the excused chore's weight leaves `totalWeight`.

- `doneWeight` already only sums `status = 'done'`, so an excused chore is naturally absent from the numerator.
- The forecast branch is unaffected: an excused chore is a materialized row, so its day is already in `materializedByDay` and is not re-forecast.

Net: removing the excused weight from the denominator means the kid can still reach 100% on their remaining chores. No penalty, no bonus.

## 8. Overdue / active filters

Add `'excused'` to the `status NOT IN (...)` clauses so a past excused chore never appears as overdue:

- `src/routes/home.js` — the assignments query: `... OR (a.due_date < ? AND a.status NOT IN ('done','expired','rejected'))` becomes `... NOT IN ('done','expired','rejected','excused')`.
- `src/routes/wall.js` — same overdue clause in the assignment query.
- `src/routes/admin/today.js` — same overdue clause in the per-kid rows query.

Today's excused chores (`due_date = today`) still appear because the `due_date = ?` branch matches regardless of status; they are displayed as excused (see UI).

## 9. Count exclusions

**Wall (`src/routes/wall.js`)** — when bucketing assignments and incrementing `total`/`done` for `house_pct`, skip rows with `status === 'excused'` (do not count them in either). The excused row is still pushed into the kid's `today` bucket for display, but flagged so the client can render it greyed and excluded from the kid's `done/total` stat.

**Admin Today (`src/routes/admin/today.js`)** — `today_total` and `today_done` exclude excused rows (`row.status !== 'excused'`). The assignment detail list returned per kid must include each row's `id`, `status`, `note`, and `title` so the UI can render and act on them.

## 10. UI surfaces

### Admin Today tab (`public/js/pages/admin.js`)

The expandable per-kid assignment list (already built) gains a per-row action:
- A non-excused, non-done row shows an "Excuse" link. Tapping it prompts (`prompt()`) for a reason, then `POST /api/admin/assignments/:id/excuse` with the note, then re-renders.
- An excused row shows "Excused: [note]" muted, with an "Undo" link calling `POST /api/admin/assignments/:id/unexcuse`.

This requires the today route to return per-assignment `id`, `status`, and `note` (see §9).

### Kid home (`public/js/pages/home.js`)

In `renderTask`, an assignment with `status === 'excused'` renders:
- Greyed out (muted text, no strike-through, distinct from "done").
- An "Excused" pill (reuse `pill-info` styling).
- The reason note shown beneath the title in small muted text.
- No action button.

The kid's "Today" list still shows the chore so they see they were excused and why.

### Wall (`public/js/pages/wall.js`)

An excused task in a kid's column renders struck-through/greyed with a small "Excused" label. It is excluded from the column's done/total stat (the server already excludes it from `house_pct`). The wall receives `status` on each task (it already does) plus the excused styling branch.

## 11. Tests

### Extend `tests/lib-streak.test.js`

- `currentStreak`: a day with one done chore and one excused chore qualifies (streak continues).
- `currentStreak`: a day with only an excused chore qualifies vacuously.
- `streakAtRisk`: returns false when the only remaining chore today is excused.

### Extend `tests/lib-points.test.js`

- `calcWeekPoints`: excusing a chore removes its weight from `totalWeight` (denominator), so a kid who did their other chores reaches a higher percent than if it counted.

### New `tests/routes-admin-excuse.test.js`

- `POST /api/admin/assignments/:id/excuse` sets status to excused and stores the note.
- Excuse with blank note defaults to 'Excused by parent'.
- Excuse rejects bonus-chore assignments (400).
- `POST /api/admin/assignments/:id/unexcuse` reverts to pending and clears note.
- Unexcuse on a non-excused assignment returns 409.
- Both endpoints reject non-parent auth.

### Extend `tests/routes-home-streak.test.js` (or routes-home)

- `GET /api/home`: an excused assignment appears in the today list with status 'excused' and its note.

Existing tests: 153. After Phase 9: ~165.

## 12. Tech notes

- `'excused'` is deliberately modeled as a terminal status, matching the existing `done`/`expired`/`rejected` pattern, so the change is a series of small additive filter clauses rather than new structures.
- Reusing `note` for the reason avoids a migration. The approval-reject flow also writes `note`, but an excused assignment is not in the approval pipeline, so the two never conflict on the same row at the same time.
- An excused chore that was previously `submitted` (photo/approval pending) can still be excused; excusing overwrites status to `excused`. Any pending photo is left as-is and will be swept by the existing retention job. This edge case is acceptable and needs no special handling.
- The generator (`generateForToday`) only creates `pending` assignments and never resurrects an excused one for the same day, since it skips dates that already have rows.

## 13. Acceptance test (manual, post-deploy)

1. As parent, open Admin → Today, expand a kid (e.g. Gabriel) who has "Walk the dogs" pending.
2. Tap "Excuse" on that chore, enter "Dog's leg is hurt". Save.
3. The row now shows "Excused: Dog's leg is hurt" with an Undo link.
4. Open Gabriel's phone: "Walk the dogs" shows greyed with an "Excused" pill and the reason, no Done button.
5. Gabriel completes his other chores. His streak ticks up (excused chore did not block it) and his percent reaches 100% on the remaining chores.
6. The wall shows "Walk the dogs" struck-through/excused and does not count it against Gabriel's done/total or house progress.
7. After 8 PM, Gabriel does NOT get a "streak at risk" warning despite the excused chore being undone.
8. Tap "Undo" in admin → the chore returns to pending and behaves normally again.
