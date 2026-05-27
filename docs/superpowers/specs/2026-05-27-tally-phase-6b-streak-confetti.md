# Tally — Phase 6b (Streak Confetti) Design

**Date:** 2026-05-27
**Project:** Tally
**Status:** Approved, ready for implementation planning
**Builds on:** Phase 6a (streaks + sick day), Phase 5 (SSE realtime wall)

---

## 1. Summary

When a kid extends their streak by completing all chores for the day, a canvas-based confetti animation fires on their phone. The family wall display also fires confetti (colored by the kid's avatar) when any kid's streak extends, triggered by SSE updates. Milestone streaks (7, 14, 30, 60, 100, then every 100) get a bigger, longer burst with a congratulatory message.

Zero new dependencies. Pure canvas animation. No backend changes.

## 2. Goals

1. **Immediate reward** when a kid finishes their last chore and their streak ticks up.
2. **Escalating milestones** so longer streaks feel increasingly celebrated.
3. **Wall celebration** so the whole family sees when someone extends a streak.
4. **Zero dependencies** — vanilla canvas animation, ~80 lines.

## 3. Non-goals (Phase 6b)

- Sound effects
- Persistent "personal best" / streak record tracking
- Confetti on admin screens
- Different particle shapes (circles only)
- Confetti on streak recovery (streak was broken, kid starts a new one at 1)

## 4. Confetti module

### New file: `public/js/lib/confetti.js`

Exports three functions:

```
fireConfetti({ count, duration, message, dominantColor })
streakConfetti(dominantColor?)
milestoneConfetti(days, dominantColor?)
```

**`fireConfetti(opts)`** — Core animation engine.

1. Creates a full-viewport `<canvas>` element, appended to `document.body`.
   - `position: fixed; inset: 0; pointer-events: none; z-index: 999;`
2. Spawns `opts.count` particles, each with:
   - Random x position across full width, y at top (0 to -20px).
   - Random color from a festive palette: `['#22C55E','#3B82F6','#EAB308','#EF4444','#A855F7','#EC4899']`. If `dominantColor` is provided, 40% of particles use that color.
   - Random radius: 4-8px.
   - Vertical velocity: 2-5 px/frame, plus gravity (0.08 px/frame acceleration).
   - Horizontal drift: -1.5 to +1.5 px/frame.
   - Spin rate: random (purely visual, affects drawn shape slightly).
   - Opacity: starts at 1.0, fades to 0 over the last 20% of the animation duration.
3. Uses `requestAnimationFrame` loop. Each frame:
   - Clears the canvas.
   - Updates each particle position (y += vy, vy += gravity, x += vx).
   - Draws each particle as a filled circle with current opacity.
   - If `opts.message` is set, draws it centered on the canvas in bold white text with a dark shadow, fading with the same opacity curve.
4. After `opts.duration` ms, stops the animation loop and removes the canvas from DOM.

**`streakConfetti(dominantColor?)`** — Preset for a normal streak extension.
- `count: 60, duration: 2000, message: null, dominantColor`

**`milestoneConfetti(days, dominantColor?)`** — Preset for milestone streaks.
- `count: 150, duration: 3500, message: '${days} day streak!'`, dominantColor`

### Milestone thresholds

A day count is a milestone if it appears in the set `[7, 14, 30, 60, 100]` or is a multiple of 100 above 100 (200, 300, ...).

Helper function (not exported, internal to confetti.js):

```
function isMilestone(days) {
  return [7, 14, 30, 60, 100].includes(days) || (days > 100 && days % 100 === 0);
}
```

Exported so trigger sites can decide which preset to call:

```
export function isMilestone(days) { ... }
```

Actually, export it so both home.js and wall.js can use it. Trigger sites call:

```js
if (isMilestone(newStreak)) milestoneConfetti(newStreak, color);
else streakConfetti(color);
```

## 5. Kid home trigger

**File:** `public/js/pages/home.js`

After each successful mutation (submit, undo, steal, claim) that calls `renderHome(root)`, the re-render fetches fresh data from `/api/home`. The `person.streak_days` value is available in the response.

**Detection logic:**

At module scope, read the last known streak from `sessionStorage.getItem('tally_last_streak')`. After each render:

1. Read `p.streak_days` from the fresh API response.
2. Compare against the stored value (parsed as integer, default 0 if missing).
3. If `p.streak_days > stored`:
   - Fire `milestoneConfetti(p.streak_days)` or `streakConfetti()` based on `isMilestone`.
4. Update `sessionStorage.setItem('tally_last_streak', String(p.streak_days))`.

This fires confetti exactly once per streak increment. `sessionStorage` is per-tab and clears when the tab closes, so reopening the app won't re-trigger.

The confetti fires AFTER the DOM has re-rendered (the new streak number is visible), so the celebration feels connected to the visual change.

No `dominantColor` on kid home — the default festive palette is used.

## 6. Wall trigger

**File:** `public/js/pages/wall.js`

**Detection logic:**

At module scope, maintain a `wallStreakCache` object (plain JS Map: `kidId -> lastKnownStreakDays`). After each `render()` that does a full redraw (not the clock-only fast path):

1. For each kid in `data.kids`:
   - Compare `kid.streak_days` against `wallStreakCache.get(kid.id)` (default 0).
   - If higher:
     - Fire `milestoneConfetti(kid.streak_days, kid.avatar_color)` or `streakConfetti(kid.avatar_color)`.
   - Update the cache: `wallStreakCache.set(kid.id, kid.streak_days)`.

The `dominantColor` is set to the kid's `avatar_color` so the confetti visually identifies which kid's streak just extended.

If multiple kids extend their streak in the same render cycle, confetti fires once per kid (the canvas overlay handles overlapping animations fine since each creates its own canvas).

On initial page load, the cache is empty (all zeros), but we do NOT fire confetti — we populate the cache silently on first render. Implementation: set a `firstRender` flag that skips confetti on the very first `render()` call.

## 7. Schema

No schema changes. No new API fields.

## 8. API surface

No changes. `streak_days` is already returned by `/api/home` (on `person`) and `/api/wall` (on each kid).

## 9. Tests

Phase 6b is purely client-side animation. No new server tests.

The confetti module could have unit tests (particle count, duration, milestone detection), but given the visual nature and zero backend impact, we'll test `isMilestone` with a simple assertion in a test file and verify the rest manually.

### New file: `tests/confetti.test.js`

- `isMilestone(7)` returns true
- `isMilestone(14)` returns true
- `isMilestone(30)` returns true
- `isMilestone(100)` returns true
- `isMilestone(200)` returns true (multiple of 100)
- `isMilestone(5)` returns false
- `isMilestone(15)` returns false
- `isMilestone(150)` returns false (not in set, not multiple of 100)

Existing tests: 137. After Phase 6b: ~145.

## 10. Tech notes

- The canvas `pointer-events: none` means confetti doesn't block tap/click events. Kids can keep using the app while confetti falls.
- Multiple confetti canvases can coexist (wall might fire for 2 kids simultaneously). Each is independent.
- The `requestAnimationFrame` loop naturally pauses when the tab is backgrounded, preventing wasted CPU.
- Canvas is removed from DOM after animation, so no memory leak from repeated celebrations.
- The festive palette `['#22C55E','#3B82F6','#EAB308','#EF4444','#A855F7','#EC4899']` is green, blue, yellow, red, purple, pink. Deliberately bright against both light and dark backgrounds.

## 11. Acceptance test (manual, post-deploy)

1. Log in as a kid who has a streak of 0.
2. Complete all assigned chores for today.
3. On the last chore completion, confetti should burst on the kid's phone (60 particles, 2s).
4. The wall should also show confetti (colored by the kid's avatar) via SSE update.
5. Refresh the kid's phone — no confetti (sessionStorage prevents re-fire).
6. Close and reopen the tab, reload — no confetti on load (sessionStorage cleared, but streak hasn't increased since last stored value was lost).
7. Set a kid's streak to 6 days (by seeding 6 days of completed assignments). Complete today to hit 7. Milestone confetti should fire (150 particles, 3.5s, "7 day streak!" message).
8. Verify confetti doesn't block tapping on chore buttons (pointer-events: none).

---

**Approved by user on 2026-05-27 via brainstorming session. Ready for implementation planning.**
