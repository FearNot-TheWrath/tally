# Bonus Chore Ripening — Design Spec

**Date:** 2026-06-01
**Status:** Approved for plan-writing
**Target release:** v0.13.0-bonus-ripening

## Summary

Make unclaimed bonus chores **ripen** over time. Each day a bonus sits on the bonus board unclaimed, its current point value rises from a configurable `min_points` toward `max_points` over `days_to_ripen` days. Once it reaches max, it gets one day of grace then auto-removes. The wall surfaces "heat" via a 3-tier color band (cool → mid → hot) so the family can see at a glance which bonuses are about to peak.

## Goals

- Reward speed for kids who grab obvious bonuses early, and reward patience for kids holding out for the higher number.
- Clear stale bonuses automatically so the board doesn't accumulate cruft.
- Stay backwards compatible with existing bonuses (no behavior change until you edit them).

## Non-goals

- Decay (bonuses going DOWN over time). Up-only.
- Per-kid pricing. Bonuses are family-wide.
- A history view of how much each bonus ripened. Out of scope; the assignment record captures the claim-time value.

## Data model

New columns on `chores` (migration 014):

```sql
ALTER TABLE chores ADD COLUMN min_points     INTEGER;  -- nullable; null = no ripening
ALTER TABLE chores ADD COLUMN max_points     INTEGER;  -- nullable; null = no ripening
ALTER TABLE chores ADD COLUMN days_to_ripen  INTEGER NOT NULL DEFAULT 5
  CHECK (days_to_ripen >= 1 AND days_to_ripen <= 30);
ALTER TABLE chores ADD COLUMN current_points INTEGER;  -- live ripened value
ALTER TABLE chores ADD COLUMN ripens_from    TEXT;     -- ISO date when this cycle started
ALTER TABLE chores ADD COLUMN ripens_full_on TEXT;     -- ISO date the bonus first reached max
```

**Backwards compat.** For existing bonuses (`kind = 'bonus'`), the migration sets `min_points = max_points = current_points = points` and `ripens_from = today`. With `min == max`, the daily step is `0`, so they never ripen — they stay at their current value forever just as they do today. Editing the chore to give it a real range turns ripening on for that one chore.

**Why duplicate `points` and `current_points`?** `points` stays as the "starting" value the parent set. `current_points` is what the wall and home see right now. When a bonus is claimed, the assignment captures `current_points`. When the bonus reappears (e.g. parent re-adds it), `current_points` resets to `min_points` and the cycle starts again.

## Ripening sweep

Lazy sweep on every wall / home / admin/today read. Same pattern as `sweepForfeits` and `runPayoutIfDue`. Cached for 60 seconds per process to avoid running it on every SSE refresh.

```js
function sweepBonusRipening(db) {
  // Find bonuses where min/max are set and current < max,
  // and where ripens_from + days-since-touched >= 1.
  // For each, compute the new value:
  //   step = round((max - min) / days_to_ripen)
  //   daysSinceTouched = today - last-touched-date  (last-touched is ripens_from + days_already_ripened)
  //   newCurrent = min(current + step * daysSinceTouched, max)
  // When current first reaches max, stamp ripens_full_on with today.
  // When today > ripens_full_on (i.e. at-max for at least 24h), soft-delete the chore.
}
```

**Step rounding.** `step = round((max - min) / days_to_ripen)`. With min=1, max=10, days=5, step=2 (rounded from 1.8). Worst case the ramp lands a tick early or late vs strictly linear; acceptable in a family app.

**One day at max.** When the sweep would push current to max for the first time, it stamps `ripens_full_on` = today and stops there. The NEXT day the sweep runs, if `ripens_full_on < today` and current is still at max, it soft-deletes by setting `chores.deleted_at = now`. So bonuses get one full day at peak value before vanishing.

## Routes touched

- **`GET /api/wall`** and **`GET /api/home`**: call `sweepBonusRipening(db)` before fetching the bonus list. The bonus query already filters by `c.kind = 'bonus' AND c.deleted_at IS NULL`, so expired bonuses fall off naturally. Also expose `current_points`, `min_points`, `max_points` so the client can compute heat.
- **`POST /api/admin/chores`** and **`PATCH /api/admin/chores/:id`**: add `min_points`, `max_points`, `days_to_ripen` to `ALLOWED_FIELDS`. On create/edit of a bonus, initialize `current_points = min_points` and `ripens_from = today` (and clear `ripens_full_on`).
- **`POST /api/bonuses/:id/claim`**: capture the chore's `current_points` into the new assignment's display-points and reset the chore's ripening state for a future re-add cycle.

## Admin UI

Chore modal grows three fields when `kind === 'bonus'`:
- `Min points` (number, required if bonus)
- `Max points` (number, required if bonus, >= min)
- `Days to ripen` (number, default 5, range 1-30)

The existing `Points` field stays — it acts as the default "starting" value for backwards compat and isn't shown when min/max are set (or it can be hidden when kind=bonus, replaced by min/max). Hide-and-replace is cleaner.

Validation:
- `min_points >= 1`
- `max_points >= min_points`
- `days_to_ripen` integer 1..30

## Wall: heat display

Each bonus card on the bonus board renders the current point value. Add a `data-heat="low|mid|high"` attribute and a class based on the ripeness percentage:

```js
const pct = (max - min) > 0
  ? (current - min) / (max - min)
  : 0;
const heat = pct <= 0.25 ? 'low'
           : pct <= 0.74 ? 'mid'
           : 'high';
```

CSS:

```css
.wall-bonus-item                  { transition: border-color 0.4s ease, box-shadow 0.4s ease; }
.wall-bonus-item[data-heat="low"]  { border-color: #22C55E; box-shadow: 0 0 0 1px rgba(34,197,94,0.2); }
.wall-bonus-item[data-heat="mid"]  { border-color: #F59E0B; box-shadow: 0 0 0 1px rgba(245,158,11,0.25); }
.wall-bonus-item[data-heat="high"] { border-color: #DC2626; box-shadow: 0 0 12px rgba(220,38,38,0.4); animation: bonus-pulse 1.6s ease-in-out infinite; }

@keyframes bonus-pulse {
  0%, 100% { box-shadow: 0 0 12px rgba(220,38,38,0.4); }
  50%      { box-shadow: 0 0 20px rgba(220,38,38,0.7); }
}
```

So bonuses are subtle green by default, amber when warm, pulsing red when ripe. The home view for kids gets the same treatment.

## Heat thresholds (per user spec)

- 0% to 25% → low / green
- 26% to 74% → mid / yellow
- 75% to 100% → high / red

Edge cases:
- `min == max`: pct is 0, always `low`. No heat from non-ripening bonuses (which is correct — they're not ramping).
- `current < min` (shouldn't happen but be defensive): clamp to 0%.

## Testing

Unit tests:
- `tests/lib-bonus-ripen.test.js`
  - Step math: min=1, max=10, days=5 → step=2 per day, lands at 10 on day 5
  - Step rounding: min=1, max=10, days=4 → step=2 (rounded from 2.25)
  - Skip-when-touched-today: running sweep twice same day is a no-op
  - Backward compat: chore with min=max=points doesn't change
  - At-max grace: bonus that hit max yesterday gets soft-deleted today
  - Multi-day catch-up: if process didn't run for 3 days, sweep applies 3 steps at once
- `tests/routes-admin-chores.test.js` additions:
  - POST bonus with min/max sets current_points = min and ripens_from = today
  - PATCH bonus with new min resets current_points and ripens_from
  - Validation: max < min rejected, days_to_ripen out of range rejected
- `tests/routes-wall.test.js` (or wherever wall integration test lives):
  - Wall response includes min_points, max_points, current_points per bonus

No automated UI tests for the heat colors; manual smoke.

## Files touched

**New:**
```
src/migrations/014-bonus-ripening.sql
src/lib/bonus-ripen.js                  the sweep function + step math
tests/lib-bonus-ripen.test.js
```

**Modified:**
```
src/routes/admin/chores.js              ALLOWED_FIELDS + create/edit init logic + validation
src/routes/wall.js                      call sweepBonusRipening + expose ripening fields
src/routes/home.js                      same as wall (sweep + fields)
public/js/pages/admin.js                chore modal grows min/max/days inputs for bonus kind
public/js/pages/wall.js                 bonus card includes data-heat + class
public/css/layouts.css                  .wall-bonus-item[data-heat=...] rules + keyframes
tests/routes-admin-chores.test.js       (additions)
```

## Out of scope (explicit)

- Per-kid ripening rates.
- Notification on bonus board changes.
- Daily reset of expired-but-recurring bonuses (parent re-adds them manually).
- Ripening graph / history view.
- Custom heat color palettes (3-bucket green/yellow/red is fixed).

## Phasing

Single phase, single tag (`v0.13.0-bonus-ripening`). No Phase 2.

## Open decisions (deferred to plan-writing)

- Whether `points` field on bonus chores gets hidden vs shown-but-disabled in admin UI when min/max are set. Lean toward hide.
- Whether the kid home view's bonus board gets the same heat colors as the wall. Spec says yes; confirm in plan.
