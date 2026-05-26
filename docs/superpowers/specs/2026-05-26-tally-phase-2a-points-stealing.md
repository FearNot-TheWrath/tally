# Tally — Phase 2a (Weighted Points + Chore Stealing) Design

**Date:** 2026-05-26
**Project:** Tally
**Status:** Approved, ready for implementation planning
**Supersedes:** Replaces the fixed `chores.points` model with a weighted dynamic system. Sets up the path for Phase 2b (Sunday settle + ledger).

---

## 1. Summary

Today each chore has a fixed integer point value and the kid's `weekly_target_pts` is set independently. The two numbers don't relate — assigning 13 chores of 5 pts each gives a kid 455 weekly pts against a 100 target. Result: the target is meaningless and the kid hero card shows `0 / 100` because `points_this_week` is read from a column that doesn't exist.

Phase 2a fixes this by treating the weekly target as a fixed ceiling and distributing it across each kid's chores by **weight (1-5)**. Completion is computed as a continuous ratio: `done_weight / total_weight × target`. Adding or removing chores rebalances immediately.

It also adds **chore stealing**: after a configurable time (default 4 PM local), any sibling can claim a pending chore that isn't flagged as school work. Stolen chores are extra credit for the stealer (points beyond 100% earn the per-point bonus rate) and an opportunity cost for the original kid (they're still on the hook for the weight but didn't do the work).

Projected weekly pay is shown live to both the kid (on the hero card) and the parent (on People rows).

**Out of scope for Phase 2a, deferred to Phase 2b:** Sunday settle workflow, ledger entries, bank balance, on-demand withdrawals. Phase 2a only *displays* the projected number — payment still happens manually outside the app, like today.

## 2. Goals

1. **Weekly target = real ceiling.** Doing all assigned chores = exactly 100% = full base pay.
2. **Weights, not arbitrary points.** Parent picks 1-5 per chore reflecting effort.
3. **Add/remove is safe.** Adding a chore mid-week dilutes the rest proportionally; removing concentrates them. Already-completed work isn't retroactively devalued in a ledger sense (Phase 2a doesn't write a ledger yet; the running ratio is the source of truth).
4. **Stealing is extra credit.** After 4 PM, non-school chores can be claimed by siblings; the stealer's done_weight increases but their total_weight doesn't, pushing them past 100%.
5. **Projected pay visible.** Kid and parent both see live `$X.XX projected this week`.

## 3. Non-goals (Phase 2a)

- No ledger writes. No `ledger_entries` rows from this phase.
- No Sunday settle UI or "mark paid" flow.
- No per-kid bank balance accrual.
- No streak calculation (still deferred).
- No retroactive payout adjustment when chores are added/removed (the running ratio updates, but past weeks aren't touched).

## 4. Point math

For a kid `p` and a week `w` (Monday-Sunday local):

```
original_assignments(p, w) = assignments where due_date BETWEEN w_start AND w_end
                              AND (person_id = p AND stolen_from IS NULL
                                   OR stolen_from = p)

current_assignments(p, w)  = assignments where due_date BETWEEN w_start AND w_end
                              AND person_id = p

total_weight(p, w) = SUM(chore.weight) for original_assignments(p, w)
own_done_weight(p, w) = SUM(chore.weight) for current_assignments(p, w)
                                          where status = 'done'
                                            AND stolen_from IS NULL
stolen_in_done_weight(p, w) = SUM(chore.weight) for current_assignments(p, w)
                                                 where status = 'done'
                                                   AND stolen_from IS NOT NULL

done_weight(p, w) = own_done_weight + stolen_in_done_weight
percent(p, w)     = done_weight / total_weight  (or 0 if total_weight = 0)
points(p, w)      = round(percent × p.weekly_target_pts)
```

`original_assignments` is what the kid's denominator was built from at start of week — currently-theirs (never stolen) plus stolen-away-from-them. The stolen-away ones stay in the denominator: the kid is still on the hook for the weight, they just lose the opportunity to do it themselves.

`current_assignments` is what's on the kid's home today: currently-theirs (whether stolen-in or original).

Per-chore display points (what shows on each chore row): `round(chore.weight / total_weight × target)`. This formula uses the kid's own `total_weight` (their original denominator). For stolen-in chores that aren't in `total_weight`, the same formula still applies: a stolen +3 chore in Olivia's week (her total_weight = 50, target = 100) displays as 3/50×100 = +6 pts. Completing it adds 6 to her percent (which can push past 100%).

## 5. Payment math

Uses the existing `people` columns: `weekly_target_pts`, `base_pay_cents`, `bonus_rate_cents`.

```
base_part     = min(percent, 1.0) × base_pay_cents
bonus_part    = max(0, points - target_pts) × bonus_rate_cents
projected_pay = base_part + bonus_part        (in cents)
```

The "% capped at 100%" for the base ensures stealers don't get double-paid from base. The bonus pool comes from the per-point bonus rate applied to points earned over 100%.

Worked example for Olivia (target 100, base 1000, bonus 10):

| Scenario | total | done | % | pts | base | bonus | $ |
|---|---|---|---|---|---|---|---|
| Half done | 50 | 25 | 50% | 50 | 500 | 0 | $5.00 |
| All assigned | 50 | 50 | 100% | 100 | 1000 | 0 | $10.00 |
| All + stole +3 | 50 | 53 | 106% | 106 | 1000 | 60 | $10.60 |

## 6. Stealing

### What's stealable

An assignment is stealable IFF:
- `chore.is_school_work = 0`
- `assignment.status = 'pending'`
- `assignment.due_date = today`
- `now() local time >= settings.steal_unlock_time` (default `16:00`)

### Endpoint

`POST /api/assignments/:id/steal`
- requireRole('kid')
- 403 if caller is current `assignment.person_id` (can't steal from yourself)
- 400 if not stealable (school work, wrong status, wrong day, before unlock time)
- 409 on race (another sibling beat them to it — conditional UPDATE returned 0 changes)
- 200 on success

The conditional update is the race guard:

```sql
UPDATE assignments
SET person_id = :stealer,
    stolen_from = :original,
    updated_at = datetime('now')
WHERE id = :id
  AND status = 'pending'
  AND person_id != :stealer
  AND person_id = :original
RETURNING *;
```

Returns the updated row or none. If none, return 409.

### UI surface

**Kid home — new "Steal" section** appears after `steal_unlock_time` if any sibling has a stealable chore. Each entry: sibling avatar + chore title + `Claim · +N` button.

A successful claim re-renders the kid home (chore moves into their Today list with a small "stolen" badge).

**Original kid** sees the chore vanish from their list silently after the steal (no notification — they can check the wall to see who has it).

**Wall display** marks stolen-in chores in the stealing kid's column with a `↻ from Christopher` style badge.

## 7. Schema changes

One migration: `src/migrations/004-points-and-stealing.sql`

```sql
ALTER TABLE chores ADD COLUMN weight INTEGER NOT NULL DEFAULT 3
  CHECK (weight BETWEEN 1 AND 5);
ALTER TABLE chores ADD COLUMN is_school_work INTEGER NOT NULL DEFAULT 0;

ALTER TABLE assignments ADD COLUMN stolen_from INTEGER REFERENCES people(id);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('steal_unlock_time', '16:00');
```

Existing chores get `weight = 3` (medium) and `is_school_work = 0` by default. The user will tag school chores on next admin pass.

The existing `chores.points` column is no longer used by display logic; it stays in the schema for now to avoid migration churn but is dead code. Phase 2b can drop it.

## 8. API changes

### New

- `POST /api/assignments/:id/steal` — described in §6.

### Modified payloads

- `GET /api/home` — `person.points_this_week`, `person.percent`, `person.projected_pay_cents` are now populated. Each assignment in `today`/`overdue` carries a `display_points` field. New `stealable` array lists sibling chores currently claimable.
- `GET /api/wall` — each kid gets `points`, `percent`. Each assignment carries `display_points` and `stolen_from` (the original kid's name, for the badge).
- `GET /api/admin/today` — each kid gets `points`, `percent`, `projected_pay_cents`.
- Chore admin endpoints accept `weight` (1-5) and `is_school_work` in POST/PATCH `ALLOWED_FIELDS`.

### A new helper module

`src/lib/points.js` exporting:
- `calcWeekPoints(db, personId, weekStartIso)` — returns `{ totalWeight, doneWeight, percent, points }`
- `calcProjectedPay(person, points)` — returns `cents` given the person row and points number
- `weekStartFor(dateIso)` — wraps `weekStart()` from `lib/dates.js` for ergonomics

Pure functions, no IO except the read in `calcWeekPoints`. Easy to unit test.

## 9. UI changes

### Admin — Chore edit modal

Two new fields in the `editChore` form:
- **Weight** select: `1 (very light)` / `2 (light)` / `3 (medium, default)` / `4 (heavy)` / `5 (very heavy)`
- **School work — cannot be stolen** checkbox

Chore row in Chores tab list shows weight as `●●●○○` style dots next to the title.

### Admin — Settings tab (NEW)

Inserted at end of TABS after Chores. Initially has one input:
- **Steal unlock time** `HH:MM` (default `16:00`)

Saves immediately on blur via `PATCH /api/admin/settings/:key` (new endpoint accepting key + value).

This is a placeholder tab — future settings (payout day, reminder time, photo retention) land here too.

### Kid home

- Hero card: `42 pts · 42%` (was `0 / 100 pts`). Same bar, fill = percent.
- Below hero, a small projected-pay line: `~$4.20 projected this week`.
- Each chore row's "+N" is computed dynamically (see §4).
- New "Steal" section after `steal_unlock_time`:
  - Title: "Steal from a sibling"
  - Rows: sibling chip + chore title + `Claim · +N` button
- Stolen-in chores in the kid's Today list show a small `↻ from <kid>` badge.

### Wall display

- Banner: `House Y%` (was just X/Y stats)
- Each kid column header: `X pts · Y%` 
- Stolen chore in the stealing kid's column gets `↻ Christopher` badge

## 10. Tech notes

- **Time zone**: server uses the box's local time (acutis-box is `America/Chicago`). All "today" / "now" comparisons happen on the server. Frontend doesn't need TZ logic.
- **DST**: `steal_unlock_time` is a wall-clock value (`HH:MM`). Acutis-box's local time follows DST so `16:00` is 4 PM regardless of CST/CDT.
- **Tests**: new `tests/lib-points.test.js` covering `calcWeekPoints` (zero-weight, all-done, partial, with-steals), `tests/routes-steal.test.js` covering the steal endpoint (success, 403 self-steal, 400 school-work, 409 race).
- **Generator interaction**: when a chore is created or edited, the generator already runs (Phase 1 fix). It only adds rows; weight is read at display time. No generator changes needed.

## 11. Build phases within 2a

This single phase, but logically:

1. Migration + `chores.weight` + `chores.is_school_work` + `assignments.stolen_from` + `steal_unlock_time` setting
2. `src/lib/points.js` with `calcWeekPoints` + `calcProjectedPay`
3. Wire into `/api/home`, `/api/wall`, `/api/admin/today`
4. Chore edit modal: weight + school checkbox
5. Kid home: hero shows real points + projected pay + dynamic per-chore display
6. Wall: real points + percent
7. Stealable detection in `/api/home`; new `POST /api/assignments/:id/steal`
8. Kid home "Steal" section
9. Settings tab + PATCH /api/admin/settings/:key

## 12. Acceptance test (manual, after deploy)

1. In admin → Chores, edit one chore: set weight=5 (heavy), check "School work". Save.
2. In admin → Chores, edit another: weight=1 (very light), uncheck "School work".
3. Open kid PWA as Olivia. Hero card now shows `~X pts · Y%` (not `0`). Refresh after tapping Done — points update.
4. As parent in admin → Settings, set steal unlock time to current time minus 1 minute.
5. Log in as Christopher on a separate browser. Open his home. The Steal section appears with Olivia's pending non-school chores.
6. Tap Claim on one. It moves to Christopher's Today list with a "↻ from Olivia" badge. Olivia's home loses that chore.
7. Christopher completes it. His hero card percent goes over 100%; projected pay shows base + bonus.
8. Wall display reflects the same in real time (well, on next 10s poll).

---

**Approved by user on 2026-05-26 via brainstorming session. Ready for implementation planning.**
