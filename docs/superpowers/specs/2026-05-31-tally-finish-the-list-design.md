# Tally — Finish the List Design

**Date:** 2026-05-31
**Project:** Tally
**Status:** Approved, ready for implementation planning
**Builds on:** Phase 3 (anti-cheat photos + retention), v0.10.1 (freeze suspends the day), v0.10.0 (unstealable rename), Phase 9 (chore excusals + status='excused' machinery), Phase 6a (streaks)

---

## 1. Summary

Three loose ends from the running roadmap, bundled because each is small and independent:

1. **Configurable photo retention.** `photo_retention_days` is in the settings whitelist but isn't wired — the retention sweep uses a hardcoded `5`. Read the setting (default 5), expose a Settings UI input.
2. **Freeze PATCH validation.** A `PATCH /api/admin/people/:id` that sends only one freeze bound (start without end, or vice versa) currently no-ops the sweep silently while saving a half-freeze. Add a 400 guard so half-freezes are explicitly rejected.
3. **School-work 4 PM deadline.** Mark certain chores (homework, music practice) as school-work. If not done by a configurable cutoff (default 4 PM), the chore forfeits its points (weight stays in the weekly denominator → real percentage drop) and breaks that day's streak — but the kid still has to complete it. Reintroduces `is_school_work` as a fresh chore flag (the original column was renamed to `unstealable`, intentionally disentangling stealability from school-status).

## 2. Goals

- **Retention:** parent can change the photo retention window from Settings; default behavior unchanged when setting is absent.
- **Freeze:** API rejects half-freeze PATCHes with a clear 400 error rather than silently no-opping.
- **School-work deadline:** dedicated flag per chore; missing the deadline forfeits points permanently for that week, breaks the streak immediately (today's grace withdrawn), but the chore remains required to complete. Bonus chores excluded.

## 3. Non-goals

- A separate "deadline time" per chore (single global `school_deadline_time` setting).
- Email/SMS warnings before the deadline (kid home already gets the existing streak-at-risk warning if push is configured; that covers it).
- A grace period after the deadline (no warning state — the moment the clock passes the cutoff, undone school work is forfeit).
- Retroactive forfeit (the sweep only stamps from today onward; past days where forfeit logic didn't exist stay as-is).
- UI rename: `unstealable` checkbox stays as `unstealable`, the new school-work checkbox is a separate field.

## 4. Loose end #1 — Configurable photo retention

### Mechanism

`purgeOldPhotos(db, uploadsDir, maxAgeDays)` currently takes `maxAgeDays` as a function parameter, defaulting to 5. The caller `server.js` passes `PHOTO_RETENTION_DAYS = 5` (hardcoded). Change:

- `purgeOldPhotos(db, uploadsDir, defaultDays = 5)` reads `settings.photo_retention_days` from the DB at the start of the sweep. If the row exists and parses as a positive integer between 1 and 30 inclusive, use it; otherwise fall back to `defaultDays`.
- `server.js` drops `PHOTO_RETENTION_DAYS`; just calls `purgeOldPhotos(db, UPLOADS_DIR)`.

### Settings tab UI (`public/js/pages/admin.js`)

Add a number input "Photo retention (days)" beneath the existing time inputs in `renderSettings`. `min=1`, `max=30`, value reads `s.photo_retention_days || '5'`. On change PATCHes `/api/admin/settings/photo_retention_days` (already whitelisted). Same flash-on-success pattern as the time fields.

### Tests

- `purgeOldPhotos` with `photo_retention_days = 1` set in settings: a 2-day-old file is deleted (when default would have kept it).
- `purgeOldPhotos` with no setting and no `defaultDays` override: 5-day behavior unchanged.
- Setting outside 1..30 (e.g. 0 or 100): falls back to default.

## 5. Loose end #2 — Freeze PATCH validation

### Mechanism

In `PATCH /api/admin/people/:id` (`src/routes/admin/people.js`), after `pickFields(req.body)`, before the UPDATE: if `data.freeze_start !== undefined || data.freeze_end !== undefined` (the PATCH touches freeze), enforce that BOTH fields are present in the body. A "set" is a non-empty ISO date string; an "unset" is an empty string or `null`. The valid PATCH combos are:

- Both present and truthy (setting/changing a freeze).
- Both present and empty/null (clearing the freeze).

Anything else (one truthy, the other empty/null/undefined) is a half-freeze and returns 400 with `{ error: 'freeze_start and freeze_end must be set together (or both blank to clear)' }`.

This guard runs before the UPDATE, so a half-freeze never reaches the DB.

### Tests

- Setting both bounds together succeeds.
- Clearing both bounds (both empty) succeeds.
- Setting only `freeze_start` (or only `freeze_end`) returns 400.
- Setting `freeze_start` truthy with `freeze_end = ''` returns 400.
- A PATCH that doesn't touch freeze fields is unaffected.

## 6. Loose end #3 — School-work 4 PM deadline

### Schema (migration 011)

```sql
ALTER TABLE chores ADD COLUMN is_school_work INTEGER NOT NULL DEFAULT 0
  CHECK (is_school_work IN (0, 1));
ALTER TABLE assignments ADD COLUMN forfeited INTEGER NOT NULL DEFAULT 0
  CHECK (forfeited IN (0, 1));
CREATE INDEX idx_assignments_forfeited ON assignments(forfeited) WHERE forfeited = 1;
```

`is_school_work` is independent of `unstealable`; a chore can be either, both, or neither. New chores default to non-school-work. Existing chores stay at 0 — parents opt in via the chore modal checkbox.

### Setting

`school_deadline_time` (HH:MM, default `'16:00'`) added to `EDITABLE_KEYS` in `src/routes/admin/settings.js`.

### Forfeit module: `src/lib/forfeit.js`

Exports `sweepForfeits(db)`:
1. Read `school_deadline_time` (default '16:00').
2. Compute the cutoff: today at the deadline time. If now is before today's cutoff, no chores past today's deadline yet — skip the today branch.
3. UPDATE in one statement: set `forfeited = 1` on any assignment where the joined chore has `is_school_work = 1`, the assignment's `due_date` is today AND now ≥ deadline (or `due_date < today`), `status != 'done'`, `forfeited = 0`. (`status != 'done'` so a chore the kid actually finished on time stays clean. The submit endpoint handles "completed after deadline" via the stamping path below.)
4. Guarded by a 60-second in-memory cache like `runPayoutIfDue` so it doesn't hammer the DB on every read.

Lazily called from the top of `/api/home`, `/api/wall`, and `/api/admin/today`.

### Submit endpoint stamping (`src/routes/home.js doSubmit`)

When marking an assignment done — for any anti_cheat mode — if the chore has `is_school_work = 1` AND the current local time is past `school_deadline_time` AND the assignment's `due_date` is today, set `forfeited = 1` in the same UPDATE. This catches the "kid did the homework after 4 PM" case where the sweep would have already flipped it or might not have run yet.

### Points math change (`src/lib/points.js`)

The `doneWeight` query selects `SUM(c.weight)` for assignments where `status = 'done'`, kid-owned (with stolen adjustments), non-bonus. Add `AND a.forfeited = 0` so forfeited chores contribute zero to the numerator. The denominator (`matRows`) is unchanged: forfeited chores stay in the weekly total (they're still required work), so the kid's percentage takes a real hit.

### Streak change (`src/lib/streak.js`)

`dayQualifies(db, personId, date)` currently returns true if every non-bonus, non-excused assignment on that date has `status = 'done'`. Add: a day with any `forfeited = 1` row immediately fails (return false), regardless of completion.

In `currentStreak(db, personId)`, today's "in progress" grace currently skips today on `!dayQualifies` and walks back. Change: if today has any `forfeited = 1` row, the day is a definitive fail — don't skip; break immediately so the displayed streak reflects the loss the moment the deadline passes.

`streakAtRisk(db, personId, warningTime, currentStreakValue)` — unaffected; the existing "any pending non-bonus chore" check already covers undone school work before the cutoff.

### Kid home UI (`public/js/pages/home.js`)

In `renderTask`, when `a.forfeited === 1`, render a small red pill below/next to the title: `Missed deadline · no points`. The Done button stays (they still have to do it, just for no credit) but loses the `+N` points suffix. Optionally grey the row slightly.

### Admin UI (`public/js/pages/admin.js`)

- Chore modal: new checkbox "School work — has a daily deadline" bound to `data.is_school_work`. Placed near the existing `unstealable` checkbox.
- Settings tab: new time input "School deadline (24-hour local)" using the same `timeField` helper as `streak_warning_time` and `steal_unlock_time`. Default 16:00. Hint: "School-work chores not done by this time forfeit their points and break the streak (still must be completed)."

### Tests

- `sweepForfeits` flips `forfeited=1` on a school-work chore that's still pending past 4 PM today; non-school chores are untouched.
- `sweepForfeits` no-ops if the deadline hasn't passed today.
- `doSubmit` (any anti_cheat) sets `forfeited=1` when marking a school-work chore done past the deadline; keeps `forfeited=0` when done before.
- Points: a forfeited done chore contributes 0 to `doneWeight` but its weight stays in `totalWeight`.
- Streak: a day with a forfeited row never qualifies; today's in-progress grace withdrawn if today has a forfeit.
- Chore POST/PATCH round-trips `is_school_work`.
- Settings PATCH `school_deadline_time` works (whitelisted).

## 7. API surface summary

| Endpoint / module | Change |
|---|---|
| `purgeOldPhotos` | Reads `photo_retention_days` setting (1-30, default 5). Caller no longer passes the number. |
| `PATCH /api/admin/people/:id` | Returns 400 on a half-freeze (one bound set without the other). |
| `POST /api/admin/settings/:key` | `photo_retention_days` already whitelisted (unchanged). `school_deadline_time` added to whitelist. |
| `POST /api/admin/chores` and `PATCH /api/admin/chores/:id` | `is_school_work` added to `ALLOWED_FIELDS`. |
| `GET /api/home`, `/api/wall`, `/api/admin/today` | Lazy `sweepForfeits(db)` call before computing the response (same shape as `runPayoutIfDue`). |
| `POST /api/assignments/:id/submit` (`doSubmit`) | Stamps `forfeited=1` when finishing a school-work chore past the cutoff. |

## 8. Tech notes

- The forfeit sweep + submit-stamp pair is intentional belt-and-suspenders: the sweep catches the "still pending past 4 PM" case; the submit stamp catches the "completed late" case. They never conflict (sweep only updates rows where `status != 'done'`).
- The 60-second sweep cache mirrors `runPayoutIfDue`'s pattern — single bounded UPDATE, idempotent, never blocks the response path noticeably.
- Forfeit is one-way: once stamped, it stays. There is no "unforfeit" endpoint; if a parent wants to give credit anyway, they use the existing per-assignment Undo / Excuse machinery in the Admin Today expanded view.
- `school_deadline_time` is a single global setting, not per-kid or per-chore. YAGNI.
- For the photo retention range (1-30): below 1 makes no sense (would delete fresh photos); above 30 risks unbounded disk usage on a home server. The validation in `purgeOldPhotos` enforces it server-side; the UI also limits it via `min`/`max` attributes.

## 9. Acceptance test (manual, post-deploy)

1. **Photo retention.** Admin → Settings: change "Photo retention" to 2 days. Submit a photo chore, approve it (deletes the photo immediately, but assume an unreviewed one). Wait ~2 days or manually `utimes` an `uploads/*.jpg` to 3 days ago, then trigger the sweep — the file is gone.
2. **Freeze validation.** `curl -X PATCH /api/admin/people/123 -d '{"freeze_start":"2026-06-01"}'` returns 400.
3. **School-work deadline.** Admin → Chores: edit "Math homework" to mark it as school-work. Settings: confirm school deadline = 16:00. Before 4 PM, the chore is normal. At 4:01 PM (or set the deadline to a few minutes from now): the kid's home shows the chore with "Missed deadline · no points" pill, Done button still works, completing it sets `forfeited=1` and earns no points. The kid's percent for the week drops permanently. The streak for today breaks immediately.

---

**Approved by user on 2026-05-31 via brainstorming. Ready for implementation planning.**
