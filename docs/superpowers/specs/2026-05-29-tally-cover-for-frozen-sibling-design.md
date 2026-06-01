# Tally — Cover for a Frozen Sibling Design

**Date:** 2026-05-29
**Project:** Tally
**Status:** Approved, ready for implementation planning
**Builds on:** Phase 6a (freeze columns + `isOnFreeze`), Phase 9 (chore excusals), v0.10.1 (freeze suspends the day — sweeps frozen kid's pending chores to `status='excused'`)

---

## 1. Summary

When a kid is on freeze (vacation / sick day), their excused chores currently sit invisible to the rest of the household — the work just doesn't happen. This change exposes those excused chores to the kid's *siblings* as "covers" they can claim. Claiming transfers ownership cleanly: the chore becomes a normal pending task in the claimer's list and they earn the points by doing it. The frozen kid's experience and math are unchanged.

## 2. Goals

1. **Frozen kid's excused chores show up for siblings** as claimable "covers" on the kid home.
2. **Both regular AND unstealable chores are coverable** — when the owner is out, any chore is fair game (the unstealable rule was about "siblings can't grab from each other normally", not "this chore can never be touched").
3. **No 4 PM gate** — the steal-unlock-time rule exists to keep siblings from preemptively grabbing each other's work; it doesn't apply when the owner is genuinely unavailable. Covers are claimable any time during the freeze window.
4. **Clean ownership transfer** — claiming flips the chore to the claimer entirely: `person_id = claimer`, `status = 'pending'`, no `stolen_from` link. No math weirdness with split denominators.
5. **Race-safe** — two siblings tapping "Claim" on the same row at once: one wins, the other gets 409.

## 3. Non-goals

- Reverting or modifying the existing freeze sweep — covers are additive on top.
- Allowing the frozen kid to claim their own excused chores back.
- Showing covered chores on the wall in a special way (the chore just moves to the new owner's column; the wall already reflects that via SSE).
- Covering bonus chores (bonuses are claimed individually anyway; freeze doesn't excuse them).
- Auto-claiming or any kind of round-robin assignment when a freeze is set. Siblings opt in by tapping.
- Recording "who covered for whom" history (the chore simply transfers; if we want a history view later, that's a separate feature).

## 4. Data flow

A chore becomes coverable when ALL of these are true at the time the home payload is built:
- The assignment has `status = 'excused'`.
- The assignment's owner (`person_id`) is currently on freeze for the assignment's `due_date` (i.e. `isOnFreeze(db, person_id, due_date)` returns true).
- The owner is a kid (`role = 'kid'`) other than the requesting kid.

When a sibling claims it:
- The assignment is updated: `person_id = claimerId`, `status = 'pending'`, `note = ''`, `stolen_from = NULL`, `updated_at = now`.
- Nothing else about the frozen kid changes — they keep their `freeze_start`/`freeze_end`, their other chores stay excused.
- `notifyWall()` fires so other clients see the change.

After claim, the chore is a normal pending task for the claimer: their next `/api/home` shows it in Today, they can mark it done / submit a photo / etc. via the existing flows. The points math credits them via the standard `person_id = claimer AND stolen_from IS NULL` matRows branch.

## 5. API surface

### Modified: `GET /api/home`

Adds a `covers` array on the response, alongside the existing `stealable`. Each entry mirrors the steal-row shape so the client can render it similarly:

```js
covers: [
  {
    id: <assignment_id>,
    title: <chore.title>,
    weight: <chore.weight>,
    anti_cheat: <chore.anti_cheat>,
    owner_id: <person_id>,
    owner_name: <person.name>,
    owner_color: <person.avatar_color>,
    display_points: <computed_for_claimer>,
  },
  ...
]
```

`display_points` uses the same formula already applied to the claimer's stealable rows: `Math.round(weight / totalWeight * target)`, where `totalWeight` and `target` are the claimer's, not the original owner's.

Query: select assignments where `status = 'excused'` AND the joined chore's `kind != 'bonus'` AND the joined owner has `role = 'kid'` AND `person_id != requestingKidId` AND `isOnFreeze(db, person_id, a.due_date)` is true. Bonus chores are excluded (they're never assigned via freeze sweep anyway, but explicit is safer).

The `isOnFreeze` check is per-row JS rather than SQL since the helper already exists and freezes are small in number — clarity wins.

### New: `POST /api/assignments/:id/claim-cover`

Kid-only (`requireRole('kid')`). Logic:
1. Fetch the assignment + joined chore + joined owner: `SELECT a.id, a.person_id, a.due_date, a.status, c.kind, p.role FROM assignments a JOIN chores c ON c.id = a.chore_id JOIN people p ON p.id = a.person_id WHERE a.id = ?`.
2. Validate, in order:
   - 404 if not found.
   - 409 if `status != 'excused'` (already claimed, never excused, etc.).
   - 400 if `chore.kind == 'bonus'`.
   - 403 if `owner.role != 'kid'` or `person_id == requestingKidId`.
   - 400 if `!isOnFreeze(db, person_id, due_date)` (the chore is excused but not due to a freeze — likely parent-excused, leave alone).
3. Race-guarded UPDATE:
   ```sql
   UPDATE assignments
   SET person_id = ?, status = 'pending', note = '', stolen_from = NULL, updated_at = datetime('now')
   WHERE id = ? AND status = 'excused'
   ```
   Returns `result.changes`. If 0 → 409 "Already claimed" (someone beat us to it between the SELECT and the UPDATE).
4. On success: `res.json({ ok: true })`; then `notifyWall()`.

## 6. Kid home UI

`public/js/pages/home.js`. Add a new section, modeled exactly on the existing "Steal from a sibling" section:

- Renders only when `data.covers && data.covers.length > 0`.
- Label: "Cover for a sibling".
- Each row: sibling's avatar chip (using `owner_color`), the chore title in larger text, the sibling's name in muted small text underneath ("for Gabriel"), and a "Claim · +N" button on the right.
- Button onClick: `POST /api/assignments/${id}/claim-cover`; on success, `renderHome(root)`. On 409 alert "Already claimed by someone else" and re-render. Other errors alert and re-enable the button.

Placement: render the "Cover for a sibling" section directly above the existing "Steal from a sibling" section. Both belong to the "ways to earn extra by helping" group, and covers (someone's actually out) outrank steals (someone's just slow) in user value.

## 7. Tests

### Extend `tests/routes-home.test.js` (or wherever home is tested)

- `GET /api/home` for kid B returns a `covers` entry for kid A's excused chore when A is on freeze today, and the entry includes `owner_name='A'` and `owner_color`.
- `GET /api/home` for kid B excludes a kid A excused chore if A is NOT on freeze today (e.g., parent-excused via the per-chore excuse endpoint).
- `GET /api/home` for kid B excludes their own excused chores from `covers` (a kid shouldn't see their own).
- `GET /api/home` covers excludes bonus-kind chores.

### New file: `tests/routes-claim-cover.test.js`

- `POST /api/assignments/:id/claim-cover` transfers ownership: assignment now `person_id = claimer`, `status = 'pending'`, `note = ''`, `stolen_from IS NULL`.
- `claim-cover` returns 404 if the assignment doesn't exist.
- `claim-cover` returns 409 if the assignment isn't currently excused.
- `claim-cover` returns 400 if the owner isn't on freeze for the chore's due_date.
- `claim-cover` returns 403 if claimer tries to claim their own excused chore.
- `claim-cover` returns 400 for a bonus-kind chore.
- `claim-cover` is race-safe: a second concurrent call sees `result.changes == 0` and returns 409.
- After claim, the claimer's next `GET /api/home` shows the chore in their Today list (status pending).

Existing tests: 192. After this feature: ~200.

## 8. Tech notes

- Reuses `isOnFreeze(db, personId, dateIso)` already exported from `src/lib/streak.js`.
- The points math for the claimer needs no change: the existing `matRows` query in `src/lib/points.js` already handles "chores I own with no stolen_from" via its `(person_id = ? AND stolen_from IS NULL)` branch — that's exactly what a claimed cover becomes.
- The frozen kid's math is unaffected because the cover's `status` flips from `'excused'` to `'pending'` AND its `person_id` simultaneously flips away from them. The `matRows` query never looks for chores tied to the frozen kid that have status pending (their own excused rows already excluded; the now-claimed row no longer points to them at all).
- No `stolen_from` is set, so the "from X" badge in the kid UI is intentionally absent on claimed covers — they're not stealing, they're covering. Clean transfer.
- Race safety hinges on the `WHERE status = 'excused'` predicate in the UPDATE; better-sqlite3 returns `changes` from `run()` so the handler can detect the loss and respond 409 without rolling back the transaction.

## 9. Acceptance test (manual, post-deploy)

1. As parent, freeze Gabriel for today via Admin → People.
2. Gabriel's pending chores get swept to excused (existing v0.10.1 behavior).
3. Open Olivia's phone — under the existing chore list, a "Cover for a sibling" section appears listing Gabriel's excused chores with his avatar color and "for Gabriel" label.
4. Olivia taps "Claim" on "Walk the dogs." The row vanishes from her covers list and appears in her Today list as a normal pending chore.
5. She marks it done. Points credit her per normal math; Gabriel's math is unchanged (he had 0 contribution from that day).
6. Christopher's phone: the row no longer appears in his covers list (already claimed).
7. Wall display: the chore now sits in Olivia's column. Gabriel's column shows whatever excused / 0 state it already had.
