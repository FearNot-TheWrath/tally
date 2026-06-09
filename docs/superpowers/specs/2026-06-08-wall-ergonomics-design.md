# Wall Ergonomics — Design Spec

**Date:** 2026-06-08
**Status:** Approved for plan-writing
**Target release:** v0.14.0-wall-ergonomics

## Summary

Refactor the wall configuration surface: lift all `wall_*` settings out of the main Settings tab into a dedicated **Wall** tab, replace the all-others-share-one-number rotation timing with per-panel dwell, add a smart-cycle toggle, and let the user enter a zip code (or city name) instead of raw lat/lon. No new external dependencies, no new visual panels.

## Goals

- One-stop "Wall" admin tab so the main Settings tab stops growing.
- Per-panel dwell time so the parent can tune which panels they look at more.
- Smart cycle on/off so the parent can choose chores-as-home-base vs flat rotation.
- Zip code input so non-engineers don't have to look up `-97.5469` ever again.

## Non-goals

- No calendar work (that's v0.15.0).
- No new panels.
- No visual redesign of the wall itself.
- No changes to the smart-cycle math beyond "honor per-panel dwell instead of one others-share-this number".

## Settings: keys added + dropped

**Add:**
| key | default | notes |
|---|---|---|
| `wall_smart_cycle` | `on` | `on` or `off`. On = chores returns between every other panel (current behavior). Off = flat rotation through enabled panels in declared order. |
| `wall_weather_dwell_sec` | `15` | int 5..600 |
| `wall_calendar_dwell_sec` | `15` | int 5..600 |
| `wall_verse_dwell_sec` | `15` | int 5..600 |
| `wall_weather_location` | `` (empty) | Freeform string. Zip code (`78634`), city + state (`Hutto, TX`), or `lat,lon`. Resolved server-side to lat/lon on PATCH. |

**Migrate-and-replace:**
- `wall_other_dwell_sec` → migration 015 copies its current value into the three new `wall_*_dwell_sec` keys for any panel that doesn't already have a value. The old key stays in the DB but is no longer read; the settings UI stops surfacing it.

**Unchanged:**
- `wall_chores_dwell_sec`, `wall_weather_lat`, `wall_weather_lon`, `wall_weather_unit`, `wall_sleep_start`, `wall_sleep_end`, `wall_sleep_clock_style`, `wall_enabled_panels`.

`wall_weather_lat` and `wall_weather_lon` stay as the source-of-truth for the weather route; the new `wall_weather_location` is the user-facing input that resolves into them on save.

## Geocoding

New server lib `src/lib/wall/geocode.js`. On PATCH `wall_weather_location`:

1. Trim and detect format:
   - `^[0-9]{5}$` → US zip code path. Call `https://geocoding-api.open-meteo.com/v1/search?postal_code=<zip>&country=US&count=1`.
   - `^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$` → literal `lat,lon`. Parse directly, no API call.
   - Otherwise → city/place path. Call `https://geocoding-api.open-meteo.com/v1/search?name=<text>&count=1`.
2. If the API returns a result, write `wall_weather_lat` and `wall_weather_lon` alongside `wall_weather_location` in a single transaction.
3. If the API returns no results or an error, accept the string as `wall_weather_location` (so the user sees what they typed echoed back), set `wall_weather_lat` and `wall_weather_lon` to empty, and the weather panel will skip itself per existing skip rules.
4. No caching; this is a one-time-on-save call. The actual weather forecast still uses the cached lat/lon path.

The geocoding endpoint is rate-limited politely (Open-Meteo's terms allow non-commercial use without an API key); a single call per save is well within tolerance.

## Rotation: per-panel dwell + smart cycle toggle

Update `public/js/wall/rotation.js`:

```js
new Rotation(enabledPanels, {
  dwellByPanel: { chores: 60, weather: 20, calendar: 15, 'verse-fact': 10 },
  smartCycle:   true,
});
```

- `nextDwellMs()` returns `dwellByPanel[current()] * 1000`. Defaults to 15s if missing.
- When `smartCycle` is `false`: `advance()` walks the enabled panels in order (`chores -> weather -> calendar -> verse -> chores -> ...`) with no special return-to-chores between.
- When `smartCycle` is `true` (default): existing behavior — chores is home base, each "other" visits between.

Both modes still honor the `shouldSkip` callback from `advance()`.

`wall.js` consumes new config keys and builds the dwellByPanel map. Removes references to `other_dwell_sec`.

## Admin: new Wall tab

Add a new entry in the `TABS` array in `public/js/pages/admin.js`:

```js
{ key: 'wall', label: 'Wall', render: renderWall },
```

Place it between `bonuses` and `bank`, so the tab strip reads:
`Today · Day review · Approvals · Bonus board · Wall · Bank · People · Chores · Settings`.

The new `renderWall` function builds four cards:

### Card 1: Panels

- Four checkboxes (Chores, Weather, Calendar, Verse/Fact). Chores is locked-on (disabled checkbox, always checked). PATCH `wall_enabled_panels` on change.
- One toggle: "Smart cycle (chores between each other panel)". PATCH `wall_smart_cycle` on change.

### Card 2: Rotation timing

For each enabled panel, one row:

```
[ Chores ]      [ 60 ] sec   60% of cycle
[ Weather ]     [ 20 ] sec   20% of cycle
[ Calendar ]    [ 15 ] sec   15% of cycle
[ Verse/Fact ]  [  5 ] sec    5% of cycle
```

- Number input per panel, 5..600, PATCH on change to the panel's `wall_<key>_dwell_sec`.
- A right-aligned text badge per row showing the computed %. Recompute live as any input changes: percentage = panel's dwell / sum of enabled panels' dwells. Format `XX% of cycle`. If smart-cycle is ON, the percentage accounts for chores being visited between every other panel (chores dwell counted once per "other visit"; otherwise once per cycle).

### Card 3: Weather

- One text input: "Location (zip code or city)". PATCH `wall_weather_location` on change. After the PATCH resolves, the UI re-renders to reflect any lat/lon that came back.
- Unit dropdown (F/C) — unchanged, PATCH `wall_weather_unit`.
- Test weather fetch button — unchanged.
- Show resolved coordinates as muted text below the location input ("Resolved to 30.5083, -97.5469" or "Could not resolve, weather will be skipped").

### Card 4: Sleep

- Sleep start time input → PATCH `wall_sleep_start`.
- Sleep end time input → PATCH `wall_sleep_end`.
- Clock style dropdown (digital / analog-minimal / analog-classic) → PATCH `wall_sleep_clock_style`.

## Settings tab cleanup

The existing "Wall Suite" card group inside `renderSettings()` is **removed**. The plain Settings tab keeps only the non-wall items (steal_unlock_time, streak_warning_time, payout_day, payout_time, photo_retention_days, school_deadline_time).

## Backwards compat

- Existing wall instances keep working: migration 015 copies `wall_other_dwell_sec` into the three new keys if they're unset.
- `wall_weather_location` is empty for existing installs; lat/lon stays as-is, the weather panel still works fine.
- The flat-cycle option is a new feature; no existing behavior changes if smart_cycle defaults to `on`.

## Testing

Unit tests:
- `tests/lib-wall-rotation.test.js` (extend): smart cycle off walks panels in order; per-panel dwell returned by `nextDwellMs()`.
- `tests/lib-wall-geocode.test.js` (new): zip path, city path, `lat,lon` path, error path returns `null`.
- `tests/routes-admin-settings-wall.test.js` (extend): patch `wall_weather_location` with a known zip triggers geocode and writes lat/lon (mock fetch); validators for `wall_smart_cycle` and the three new dwell keys.

Manual smoke:
- New tab visible.
- Toggle smart-cycle off, watch wall flat-rotate.
- Enter zip code, see lat/lon resolve in the UI.
- Change per-panel dwell, watch the % badge update.

## Files touched

**New:**
```
src/migrations/015-wall-per-panel-dwell.sql
src/lib/wall/geocode.js
tests/lib-wall-geocode.test.js
```

**Modified:**
```
src/routes/admin/settings.js          whitelist + validators + PATCH side-effect on weather_location
src/routes/wall.js                    /api/wall/config returns the new fields
public/js/wall/rotation.js            dwellByPanel + smartCycle option
public/js/pages/wall.js               consume new config; remove other_dwell_sec
public/js/pages/admin.js              renderWall + add TABS entry + remove Wall Suite block from renderSettings
tests/lib-wall-rotation.test.js       extend
tests/routes-admin-settings-wall.test.js  extend (new validators + geocode flow)
```

## Open decisions deferred to plan

- Whether the % badge for the smart-cycle on case uses "share of visible time" (more honest) or "share of slot turns" (simpler arithmetic). Lean toward share of visible time so the badge reads correctly when smart cycle is on.

## Phasing

Single phase, single tag (`v0.14.0-wall-ergonomics`). v0.15.0 (calendar overlay on weather) is a separate spec/plan that follows.
