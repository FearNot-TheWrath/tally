# Tally — Phase 6a (Streaks + Sick Day) Design

**Date:** 2026-05-26
**Project:** Tally
**Status:** Approved, ready for implementation planning
**Builds on:** Phase 1 (schema for streak/freeze columns already present), Phase 2a (weighted points + forecast), Phase 4 (bonus board)

---

## 1. Summary

A kid's streak ticks up by 1 each day they finish ALL their assigned chores; it resets on any non-frozen day that ends incomplete. Frozen days (parent-set sick-day or vacation range) are transparent — they neither increment nor reset the streak. After 8 PM local (configurable), the kid's home shows a "Streak at risk" badge if today's chores aren't done yet. The wall shows a "Streak leader" callout for the family's highest current streak.

The schema already has `people.streak_days`, `people.streak_last_date`, `people.freeze_start`, and `people.freeze_end` (migration 001). This phase wires up the actual logic on top of those columns. The computation is stateless and pure — recomputed on every read, no cron, no cache.

## 2. Goals

1. **Real streak counter** on kid home and wall, replacing the static `0d streak` placeholder.
2. **Strict streak rule** — all of today's assigned chores done. Bonus chores are NOT required to keep the streak (they're extra credit).
3. **Sick-day / vacation freeze** — parent sets a date range; streak holds through it.
4. **At-risk warning** — late in the day, hero card shows the kid they're about to lose their streak.
5. **Wall leader callout** — friendly competition by surfacing the family's longest current streak.

## 3. Non-goals (Phase 6a)

- Auto-expiring assignments during freeze (kid's home still shows them; if they don't do them, no streak penalty either way)
- Excluding frozen days from weekly pay denominator (frozen days still count against the kid's percent in the pay calc; the freeze only protects the streak)
- Streak best / personal record tracking — only current streak this phase
- Confetti animation when extending a streak — pure visuals, Phase 6b
- Weekly recap / most-improved leaderboards
- Bonus-completion streaks (bonus chores never required for streak)

## 4. Streak algorithm

Pure function exposed as `currentStreak(db, personId)`:

```
count = 0
date = today (local ISO date)

loop (max 1000 iterations as safety):
  if date is in this kid's [freeze_start..freeze_end] range:
    date -= 1 day
    continue

  if date == today AND not dayQualifies(date):
    // Today is in progress — don't count, don't break
    date -= 1 day
    continue

  if dayQualifies(date):
    count++
    date -= 1 day
    continue

  // Non-frozen past day didn't qualify — streak ends here
  break

return count
```

**`dayQualifies(db, personId, dateIso)`** returns true if and only if there are assignments materialized for this kid on this date AND every one of them has `status = 'done'`. If there are zero assignments for this kid on this date, the day **qualifies** (vacuously true — no failure possible).

The 1000-iteration safety cap is more than enough for any real streak (10 years = 3650 days), and prevents runaway loops if data is somehow malformed. In practice the loop terminates at the first non-frozen non-qualifying day.

## 5. Freeze (sick day / vacation)

Two existing columns on `people`:
- `freeze_start TEXT` — ISO date, inclusive
- `freeze_end TEXT` — ISO date, inclusive

If both are non-null, the range `[freeze_start..freeze_end]` is the freeze window. If only one is set, the freeze is treated as inactive (clearer than half-defined ranges).

**During the freeze window**:
- Chore generator behavior is unchanged. Daily/weekly/etc. chores still materialize for the kid.
- Streak walker treats frozen days as transparent (skip without affecting count).
- Pay calculation is unchanged — kid still earns or loses points based on what they did. The freeze ONLY protects the streak.

**`isOnFreeze(db, personId, dateIso = today())`** returns true if both freeze_start and freeze_end are set AND `freeze_start <= dateIso <= freeze_end`.

## 6. "Streak at risk" rule

`/api/home` returns `person.streak_at_risk = true` if all of these are true:
- Current local time `>= settings.streak_warning_time` (default `'20:00'`)
- `currentStreak(db, personId) > 0`
- Today is not frozen for this kid
- At least one assignment for today has `status != 'done'`

Note: bonus chores are excluded from this check (same as the qualifying rule). Stolen-in chores ARE included (the kid owns them now — must do them).

## 7. Wall leader callout

`/api/wall` returns a new top-level field:

```js
streak_leader: {
  name: 'Olivia',
  color: '#22C55E',
  streak_days: 12
}
```

Or `null` if no kid has a streak > 0. Computed server-side by iterating all kids, calling `currentStreak`, and selecting the max. On a tie, picks the first one alphabetically by name (stable, simple).

Wall frontend renders a small banner BELOW the existing dark gradient banner, ABOVE the kid columns:

```
Streak leader · Olivia · 12 days
```

The kid's name is colored using their `avatar_color`. Hidden if `streak_leader` is null.

Each kid's column header still shows their individual current streak (`12d streak`) as before — now actually populated.

## 8. Freeze indicator (parent + family visibility)

Wherever a kid is rendered, `on_freeze` boolean drives a small indicator:

- Admin People row: small "On freeze [Mon-Fri]" pill next to the kid's name when today is in their freeze range.
- Wall kid column header: similar small "On freeze" pill.
- Kid's own home: no special indicator (they know they're sick — no need to remind them).

Wall pill format: short and unobtrusive — just `On freeze`. The exact dates are visible in the admin People modal.

## 9. Schema

**No migration needed.** All required columns exist on `people` from migration 001:

```sql
streak_days       INTEGER NOT NULL DEFAULT 0  -- vestigial in Phase 6a; not written by this phase
streak_last_date  TEXT                         -- vestigial in Phase 6a; not written by this phase
freeze_start      TEXT                         -- written via admin People PATCH
freeze_end        TEXT                         -- written via admin People PATCH
```

`streak_days` and `streak_last_date` were originally designed for denormalized caching. Phase 6a recomputes on every read, so they're not used. They're kept in the schema for a future caching optimization if perf ever requires it.

For the warning time: a new `settings` key:
- `streak_warning_time` (string `'HH:MM'`, default `'20:00'`)

Defaulted in code on the read side: `settings.streak_warning_time || '20:00'`. Settings tab will write it on first edit. EDITABLE_KEYS gets `streak_warning_time` added.

## 10. API surface

### New library module: `src/lib/streak.js`

Three exports:

```js
currentStreak(db, personId) -> integer
streakAtRisk(db, personId, warningTime, currentStreakValue) -> boolean
isOnFreeze(db, personId, dateIso = today()) -> boolean
```

Pure functions. `currentStreak` does its own internal calls to `dayQualifies` (also defined in this module, not exported).

### Modified endpoints (no new endpoints)

**`GET /api/home`** payload additions on `person`:
- `streak_days` (integer) — computed via `currentStreak`
- `streak_at_risk` (boolean)
- `on_freeze` (boolean)

**`GET /api/wall`** payload additions:
- Each kid in `kids[]`: `streak_days` (computed), `on_freeze` (boolean) — overwrites the static value if any
- New top-level: `streak_leader: { name, color, streak_days } | null`

**`GET /api/admin/today`** payload additions per kid:
- `streak_days` (computed)
- `on_freeze` (boolean)

**`GET /api/admin/people`** — already returns `freeze_start` and `freeze_end`; no change needed. (The PATCH endpoint already accepts both per migration 001 ALLOWED_FIELDS.)

**`PATCH /api/admin/settings/:key`** — `streak_warning_time` added to `EDITABLE_KEYS` in `src/routes/admin/settings.js`.

## 11. UI surfaces

### Kid home — hero card

The existing `${p.streak_days || 0} day streak` line now shows the real computed value. Below the streak, a conditional pill:
- If `person.streak_at_risk`: amber pill "Streak at risk — finish today's chores"

### Wall display

- New banner below the dark gradient, above the kid columns:
  - `Streak leader · [Name] · [N] days` styled in the leader's avatar color
  - Hidden when `streak_leader` is null
- Per-kid column header: `Nd streak` (existing) shows real value
- Per-kid column header: `On freeze` pill next to the kid's name when `on_freeze` is true
- The bonus strip from Phase 4 is unchanged

### Admin — People

- Edit modal: add two new date inputs after the existing rate fields:
  - **Freeze start** (date)
  - **Freeze end** (date)
- People list row: small "On freeze" pill when the kid is currently in their freeze range

### Admin — Settings

- New entry on the Settings tab: **Streak warning time** (`<input type="time">`, default `20:00`)
- Auto-saves on change to `PATCH /api/admin/settings/streak_warning_time`

## 12. Tests

### New file: `tests/lib-streak.test.js`

- `currentStreak` with no assignments today → returns the count walking back through past qualifying days
- `currentStreak` with today partly done → doesn't count today, doesn't break the streak
- `currentStreak` with today fully done → counts today
- `currentStreak` with a non-frozen incomplete past day → streak breaks at that day
- `currentStreak` with a frozen day in the middle → streak walks through it
- `currentStreak` with today frozen → today is transparent
- `currentStreak` with 10+ qualifying days in a row → returns 10+
- `currentStreak` safety: malformed data doesn't infinite-loop (1000-iter cap)
- `isOnFreeze` true when both bounds set and today inside, false otherwise
- `streakAtRisk` returns false if streak is 0
- `streakAtRisk` returns false if today is frozen
- `streakAtRisk` returns false before warning time
- `streakAtRisk` returns false if all today's chores are done

### New file: `tests/routes-home-streak.test.js`

- `person.streak_days` reflects computed value (not the raw column)
- `streak_at_risk` true under the right conditions
- `on_freeze` true when today in freeze range

### Extend `tests/routes-wall.test.js`

- `streak_leader` payload exists when a kid has streak > 0
- `streak_leader` null when no kid has a streak
- Per-kid `on_freeze` flag on the kid object

Existing: 105 tests. After Phase 6a: ~118.

## 13. Tech notes

- `currentStreak` performance: walks back at most ~length-of-streak days. For a 12-day streak that's 12 SQL queries (one per day's assignment check). At family scale (3 kids × 1 query per kid × 12 days = 36 queries per `/api/wall` poll) this is fine for SQLite. If we ever scale to a public app, fold the walk into a single query.
- The materialized-day check uses a small per-day query: `SELECT status FROM assignments WHERE person_id=? AND due_date=?`. Existing index `idx_assignments_person_date` covers it.
- The wall polls every 10s. Streak leader recomputes each poll; if the leader changes due to a check-off, it'll surface within 10s (or instantly if SSE lands in Phase 5).

## 14. Acceptance test (manual, post-deploy)

1. As parent, edit a kid's People entry to set `freeze_start = today` and `freeze_end = today`. Save.
2. Open the kid's home: chores still show; doing them or not doing them doesn't break the streak.
3. Open the wall: kid's column header shows "On freeze" pill.
4. Remove the freeze (clear both date fields). Save.
5. Kid completes ALL their materialized chores today → kid hero shows `1 day streak`.
6. Wall shows "Streak leader · [kid] · 1 days" banner.
7. Wait until 8 PM (or temporarily set `streak_warning_time` to a recent time via Settings).
8. Have another kid leave 1+ chore pending → their hero card shows "Streak at risk" pill.
9. The first kid (still complete) does NOT show the at-risk pill.
10. Skip a day where the second kid doesn't complete → next day their streak is 0. The first kid's streak ticks to 2.

---

**Approved by user on 2026-05-26 via brainstorming session. Ready for implementation planning.**
