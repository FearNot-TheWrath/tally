# Tally — Freeze Suspends the Day Design

**Date:** 2026-05-29
**Project:** Tally
**Status:** Approved, ready for implementation planning
**Builds on:** Phase 6a (sick-day freeze: streak transparency, `freeze_start`/`freeze_end` columns), Phase 9 (chore excusals: `status = 'excused'` machinery)

---

## 1. Summary

Today, setting a freeze on a kid only protects their streak: chores already generated for the freeze window stay in their queue, and the chore generator keeps creating new ones during the window. This change makes a freeze actually suspend the kid's day: any pending or overdue chores within the freeze window are excused immediately (reusing the existing excused state), and the daily generator skips frozen kids so future days in the window never get new chores. Already-done chores keep their credit; past days outside the new "start" point are untouched.

## 2. Goals

1. **Setting a freeze excuses today + future pending chores** in the window. The kid stops seeing them as required work.
2. **Generator skips frozen kids** so chores aren't recreated each hour during the freeze.
3. **Already-done chores keep their credit.** A kid who finished some chores before being frozen mid-day doesn't lose those points.
4. **Past days outside the active sweep window stay untouched.** Setting `freeze_start = 3 days ago` doesn't retroactively excuse last Tuesday.
5. **Reuse existing machinery.** No new column, no new status — `status = 'excused'` already drops chores from streak, points denominator, overdue lists, and at-risk warnings; the UI already renders them greyed with a reason.

## 3. Non-goals

- Auto-reverting excused chores when a freeze is removed or shortened (one-way; parent can flip individual rows back via the existing per-row Undo on the Admin Today tab).
- Retroactive excusal of past days in the freeze window.
- Touching done / submitted / rejected / expired rows.
- Excluding bonus chores from a frozen kid (the bonus board behavior is unchanged here; that is a separate question).
- Auto-deposit / payday changes (the kid simply earns 0 for the frozen days because their required-chore denominator collapses; this is the natural consequence, no special handling).

## 4. Mechanism

A frozen chore is just an excused chore. We apply the excused status under two new triggers:

### Trigger 1: parent saves a freeze on a kid

The existing `PATCH /api/admin/people/:id` updates `freeze_start` / `freeze_end`. After a successful update where either of those fields was actually included in the request body, call `applyFreezeSweep(db, person.id)`. This is a one-shot side effect: the sweep runs once per PATCH that touches freeze dates.

### Trigger 2: generator runs

`generateForToday(db)` iterates chores and inserts assignments for each chore's `default_assignees`. It currently has no freeze awareness. Add: for each candidate `personId`, skip the insert if that kid is on freeze for the target date (`isOnFreeze(db, personId, date)`). This applies even though the generator is called only for today by default, so the protection extends naturally as each new day rolls into the freeze window.

The existing `UNIQUE` index `(chore_id, person_id, due_date)` combined with `INSERT OR IGNORE` already prevents re-creation of today's row if it exists. So even if `applyFreezeSweep` runs first and excuses today, a subsequent hourly generator tick can't accidentally re-add it.

## 5. The sweep: `src/lib/freeze.js`

New module. Exports:

```
applyFreezeSweep(db, personId)
```

Behavior:
1. Read the kid's `freeze_start` and `freeze_end`. If either is null/empty, return (no active freeze; nothing to sweep).
2. Compute the active window: `[max(freeze_start, today()), freeze_end]`. If the window is empty (e.g., `freeze_end < today()`), return.
3. Update all of the kid's assignments where:
   - `due_date` is in the active window, AND
   - `status = 'pending'`, AND
   - the joined chore has `kind != 'bonus'` (bonuses are claimed individually, not generated).
   
   Set `status = 'excused'`, `note = 'On freeze'`, `updated_at = datetime('now')`.

That's it. Done, submitted, expired, rejected, and already-excused rows are left alone (the `status = 'pending'` filter excludes them). One single `UPDATE` statement with the constrained `WHERE`.

We deliberately do NOT include overdue (`due_date < today()` and still pending) rows, because the active window starts at today. Old overdue rows from before the freeze window stay overdue.

## 6. Generator change: `src/lib/assignments.js`

In `generateForToday`, inside the per-chore assignee loop, skip `personId` if on freeze:

```js
for (const personId of assignees) {
  if (isOnFreeze(db, personId, date)) continue;
  insert.run(c.id, personId, date);
}
```

Import `isOnFreeze` from `./streak.js`. No other change.

## 7. People PATCH integration: `src/routes/admin/people.js`

After the UPDATE returns the person, before sending the response:

```js
if (data.freeze_start !== undefined || data.freeze_end !== undefined) {
  applyFreezeSweep(db, person.id);
}
```

Only triggers when the PATCH body actually included one of the freeze fields. (The whitelist `pickFields` already gates this.)

## 8. Tests

### New file: `tests/lib-freeze.test.js`

- `applyFreezeSweep` excuses a pending chore on today when freeze covers today.
- `applyFreezeSweep` leaves a `done` chore alone (today still in window).
- `applyFreezeSweep` leaves a chore on a PAST day alone, even if that past day is inside the freeze window (active window starts at today).
- `applyFreezeSweep` excuses a pending chore on a FUTURE day inside the freeze window (e.g., tomorrow if freeze covers tomorrow).
- `applyFreezeSweep` does NOT touch bonus-chore assignments (claimed bonuses stay).
- `applyFreezeSweep` is a no-op when the kid has no freeze set (both bounds null).
- `applyFreezeSweep` is a no-op when the freeze window has already ended (`freeze_end < today`).

### Extend `tests/lib-assignments.test.js` (or wherever `generateForToday` is tested)

- `generateForToday` does NOT create assignments for a kid who is on freeze today (with the freeze covering today).
- `generateForToday` still creates assignments for non-frozen kids on the same chore.

### Extend `tests/routes-admin-people.test.js`

- `PATCH /api/admin/people/:id` setting `freeze_start` + `freeze_end` covering today excuses the kid's pending chores for today.
- `PATCH` that does NOT touch freeze fields (e.g., updating `weekly_target_pts`) does NOT excuse any chores.

Existing tests: 182 (post the multi-photo / unstealable work). After this feature: ~190.

## 9. Tech notes

- The existing `isOnFreeze(db, personId, dateIso)` in `src/lib/streak.js` is reused for the generator skip; no duplication.
- The streak walker, points denominator, overdue filters, at-risk check, and admin/wall/home UI all already handle `status = 'excused'` correctly. So this change ONLY needs to flip status; the downstream behavior is automatic.
- The sweep is a single bounded `UPDATE`; idempotent (re-running on the same window does nothing because the rows are no longer pending).
- One-way semantics: if the parent removes or shortens the freeze, previously-excused rows stay excused. To restore them, the parent uses the per-assignment "Undo" already on the Admin Today expandable list. This is documented as the recovery path; it is not automated to avoid guessing intent.
- A frozen kid still SEES their excused tasks on their phone today list (greyed, "On freeze" note), so the kid knows they got a pass and why. The wall already shows the "On freeze" pill per kid column from Phase 6a.

## 10. Acceptance test (manual, post-deploy)

1. As parent, open Admin → People → edit Gabriel. Set `freeze_start = today`, `freeze_end = today + 1`. Save.
2. Gabriel's pending chores for today immediately show as "Excused: On freeze" on his phone, greyed out.
3. Any chores he had already marked done today still show as done and retain their points.
4. Wait for the hourly generator (or trigger a server restart): tomorrow's chores are NOT generated for Gabriel.
5. The wall shows Gabriel's "On freeze" pill (from Phase 6a) and his column reads 0 required today (the existing count exclusion of excused, from Phase 9).
6. Clear the freeze on Gabriel (blank both date fields). Saving the PATCH does NOT touch the already-excused rows; they remain excused. Generator resumes creating chores for him on the next tick. If the parent wants to restore any specific excused chore, they tap "Undo" on the Admin Today expandable list.
