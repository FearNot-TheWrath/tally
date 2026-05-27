# Tally — Phase 4 (Bonus Board) Design

**Date:** 2026-05-26
**Project:** Tally
**Status:** Approved, ready for implementation planning
**Builds on:** Phase 1 (skeleton), Phase 2a (weighted points + stealing), Phase 3 (anti-cheat photo + approval)

---

## 1. Summary

Bonus chores are parent-posted one-off "extra credit" tasks any kid can claim. The parent enters a title, fixed point value, anti-cheat policy, and optional description. The bonus appears on a new **Bonus Board** admin tab, on every kid's phone home, and on the wall. **First kid to tap Claim wins it** — a single assignment row is created for that kid, and the bonus disappears from the other siblings' boards. The kid then completes the chore through the existing honor/photo/approval flow. Completing it adds the bonus's fixed points to the kid's weekly total as pure extra credit, paid at `bonus_rate_cents` per point.

Bonuses stay up until claimed or the parent explicitly cancels. No auto-expiry.

## 2. Goals

1. **Parent can post ad-hoc rewards** for unusual chores (mow lawn, weed front bed) without going through the full recurring-chore setup.
2. **First-to-claim sibling dynamic** — encourages kids to check the app and act fast.
3. **Pure bonus pay** — completing a bonus pushes the kid past 100%, earning `bonus_rate_cents` per bonus point. Doesn't dilute their regular weekly target.
4. **No new tables.** Use existing `chores.kind='bonus'` (already in schema since migration 002).

## 3. Non-goals (Phase 4)

- No automatic expiry of unclaimed bonuses.
- No editing of claimed bonuses (claim is final; if wrong, parent cancels and reposts).
- No reassigning a claimed bonus to a different kid mid-flight.
- No completion notifications (web push lands in Phase 7).
- No bonus-only history / ledger view (regular admin endpoints already surface this).

## 4. Math

Bonus completions add to the kid's points number directly but do NOT enter `total_weight`. Effect: percent crosses 100%, and the extra points go through the bonus rate.

The existing `calcWeekPoints` gets a new `bonusPoints` field. The existing `calcProjectedPay` interprets stolen-in over-target points AND bonus points as the bonus pool.

```
weightedPoints = round(doneWeight / totalWeight × target)   // from Phase 2a
bonusPoints    = SUM(chores.points) WHERE chore.kind='bonus'
                                       AND assignment.person_id = kid
                                       AND assignment.status = 'done'
                                       AND assignment.due_date BETWEEN weekStart AND weekStart+6

points         = weightedPoints + bonusPoints
percent        = points / target

base_part      = min(weightedPoints / target, 1.0) × base_pay_cents
extraPoints    = max(0, weightedPoints - target) + bonusPoints
bonus_part     = extraPoints × bonus_rate_cents
projected_pay  = base_part + bonus_part
```

Worked example (Olivia: target 100, base $10, bonus $0.10/pt):

| Scenario | weighted | bonus | points | base | bonus_part | total |
|---|---|---|---|---|---|---|
| All chores done, no bonuses | 100 | 0 | 100 | $10.00 | $0 | $10.00 |
| All chores + claimed 30-pt bonus | 100 | 30 | 130 | $10.00 | $3.00 | $13.00 |
| Half chores + claimed 30-pt bonus | 50 | 30 | 80 | $5.00 | $3.00 | $8.00 |
| All chores + 30-pt bonus + 3 weight stolen | 106 | 30 | 136 | $10.00 | $0.60 + $3.00 | $13.60 |

## 5. Data model

**No schema migration needed.** Existing schema accommodates bonuses:

- `chores.kind = 'bonus'` (already in CHECK constraint from migration 002)
- `chores.recurs = 'none'`, `default_assignees = ''` (empty), `weight = anything` (ignored at calc time for bonuses)
- `chores.points` is the fixed bonus value (existing column, previously dead for the weighted-recurring model but meaningful here)
- `chores.deleted_at` for soft-delete (used for cancellation)
- `assignments` table unchanged; one assignment row per claimed bonus

Lifecycle:

| State | DB |
|---|---|
| Posted, unclaimed | `chores` row with `kind='bonus'`, `deleted_at IS NULL`, NO assignment row exists |
| Claimed, pending | assignment row exists with `person_id = claiming kid`, `due_date = today`, `status = 'pending'` |
| Submitted (photo / approval) | assignment `status = 'submitted'`, optionally with `photo_path` |
| Done | assignment `status = 'done'` |
| Cancelled by parent | `chores.deleted_at` set; if a claim assignment exists, it stays (history) |

**Race guard on claim:** atomic INSERT with WHERE NOT EXISTS:

```sql
INSERT INTO assignments (chore_id, person_id, due_date, status)
SELECT ?, ?, date('now', 'localtime'), 'pending'
WHERE NOT EXISTS (SELECT 1 FROM assignments WHERE chore_id = ?)
RETURNING id;
```

If another sibling claimed first, the SELECT returns no rows, the INSERT inserts nothing, RETURNING is empty. The endpoint returns 409.

## 6. API surface

### New endpoints

| Method + Path | Purpose | Role |
|---|---|---|
| `GET /api/admin/bonuses` | List active (unclaimed) + recently-claimed bonus chores | parent |
| `POST /api/admin/bonuses` | Create a bonus chore (title, points, anti_cheat, description, photo_prompt) | parent |
| `PATCH /api/admin/bonuses/:chore_id` | Edit an UNCLAIMED bonus's fields (title, points, etc.) | parent |
| `DELETE /api/admin/bonuses/:chore_id` | Cancel a bonus (soft-delete `chores`) | parent |
| `POST /api/bonuses/:chore_id/claim` | Kid claims an unclaimed bonus | kid |

`POST /api/admin/bonuses` enforces: `kind = 'bonus'`, `recurs = 'none'`, `default_assignees = ''`. Other fields whitelisted same as regular chore POST.

`PATCH /api/admin/bonuses/:id` rejects if an assignment exists (only unclaimed bonuses are editable).

`DELETE` does soft-delete + a SELECT on assignments to inform the response of whether it had been claimed.

`POST /api/bonuses/:chore_id/claim`:
- requireRole('kid')
- 404 if chore not found, deleted, or not kind='bonus'
- 409 if already claimed (the WHERE NOT EXISTS returns 0 rows)
- 200 + { assignment_id } on success

### Modified payloads

- `GET /api/home` — adds `bonuses` array: each unclaimed bonus chore's id, title, points, anti_cheat, description, photo_prompt
- `GET /api/wall` — adds `bonuses` array: same shape as `/api/home` (id, title, points, anti_cheat)
- `GET /api/admin/today` — already shows per-kid points; no change needed (bonus points roll up via calcWeekPoints)

### Library functions modified

- `src/lib/points.js` `calcWeekPoints(db, personId, weekStartIso)` returns a new `bonusPoints` field and includes it in `points`. `calcProjectedPay(person, points, bonusPoints?)` adds bonus_part from bonus points. Backward compatible: existing callers continue to work if they ignore `bonusPoints`; new bonus-aware callers pass it.

  Concretely, the new return shape:
  ```js
  { totalWeight, doneWeight, weightedPercent, weightedPoints, bonusPoints, points, percent }
  ```
  where `points = weightedPoints + bonusPoints` and `percent = points / target`.

  `calcProjectedPay` signature stays `(person, points)` but the documented usage is to pass `weightedPoints + bonusPoints` as `points`, and the function continues to apply the "extra over target" rule. The extra accounts for both stolen-in and bonus naturally because both push `points` past target.

## 7. UI surfaces

### Admin — new "Bonus Board" tab

Inserted between **Approvals** and **People** in the admin TABS array. Two sections rendered top-to-bottom:

1. **Quick-add form** — inline, no modal:
   - Title (text)
   - Points (number, default 10)
   - Anti-cheat (select: honor / photo / approval, default honor)
   - Description (optional textarea)
   - Photo prompt (optional, only enabled when anti-cheat = photo)
   - "Post bonus" button

2. **List of active + recent bonuses** — most recent first. Each row shows:
   - Title + point value chip
   - Anti-cheat indicator
   - Status: "Unclaimed" or "Claimed by [Kid] · [status]"
   - Actions: Edit (only if unclaimed) and Cancel
   - Claimed bonuses fade out after 7 days so the list stays tidy

### Kid home — new "Bonus Board" section

Appears between **Today** and **Steal** section (if any), only when there's at least one unclaimed bonus. Section heading: "Bonus board". Each unclaimed bonus row:
- Anti-cheat icon (honor/photo/approval)
- Title
- `Claim · +N pts` primary button
- Tap → POST claim → on success, refresh the home (bonus now in Today list as the kid's chore)
- On 409 race: alert "Someone beat you to it" and refresh

### Wall display — new "Bonus Board" strip

Appears below the three kid columns when at least one bonus is unclaimed. Horizontal strip of cards:
- Each card: title + point value + small "up for grabs" pill
- When all bonuses are claimed/cancelled, the strip is hidden (just disappears, no placeholder)

Claimed bonuses show up in the claiming kid's column with a small ★ Bonus badge next to the title.

## 8. Tech notes

- **Whitelisted POST/PATCH fields** for bonuses: `title`, `description`, `points`, `anti_cheat`, `photo_prompt`. Hardcoded server-side to set `kind='bonus'`, `recurs='none'`, `default_assignees=''`. Don't let the parent client override these.
- **calcWeekPoints query** for bonusPoints: same week-range filter as the existing done-weight query, but with `AND chores.kind = 'bonus'` and `SUM(chores.points)` instead of `SUM(chores.weight)`. Single extra prepared statement, executed at the same time as the existing two.
- **Cache headers** unchanged (no-cache origin-side already from earlier fix).
- **Generator interaction:** the recurring-chore generator (Task 9 from Phase 1) reads `WHERE kind = 'recurring'`. Bonus chores are correctly skipped. No change needed there.
- **`chores.weight` for bonus rows** stays at whatever default the row was inserted with (3 from CHECK default). Unused for bonus kind; do not display.

## 9. Tests

New test files:

- `tests/routes-admin-bonuses.test.js` — list, create, edit-while-unclaimed, edit-after-claimed-403, cancel, role-gating
- `tests/routes-bonuses-claim.test.js` — claim success, 409 race (two simultaneous claims), 404 missing/deleted, 404 wrong kind, parent-cannot-claim
- Extend `tests/lib-points.test.js` — `calcWeekPoints` now returns `bonusPoints`; assertion that completed bonus adds to `points` and pushes percent above 1.0
- Extend `tests/routes-home.test.js` — `bonuses` array in response, includes unclaimed bonuses, excludes claimed ones
- Extend `tests/routes-wall.test.js` — `bonuses` array in response

Existing test count: 86 → target after Phase 4: ~100.

## 10. Acceptance test (manual, post-deploy)

1. Sign in as parent. Open admin → Bonus Board tab.
2. Post a bonus: "Mow lawn", 30 pts, anti-cheat = honor. Submit.
3. Confirm the row appears with "Unclaimed" status.
4. Open the wall in a separate browser. Confirm the bonus strip shows "Mow lawn · +30 pts".
5. Sign in as Olivia on a phone. Confirm the Bonus Board section appears on her home with the bonus.
6. Tap Claim · +30. Bonus disappears from her Bonus Board and appears in her Today list.
7. Sign in as Christopher on another phone (or browser). Confirm the bonus is GONE from his Bonus Board.
8. Back as Olivia: tap Done on "Mow lawn". It strikes through.
9. Olivia's hero card: points should jump by 30 (her bonusPoints + her weightedPoints). Projected pay reflects +$3 (30 pts × $0.10).
10. Wall: "Mow lawn" now shows in Olivia's column with the ★ Bonus badge.

---

**Approved by user on 2026-05-26 via brainstorming session. Ready for implementation planning.**
