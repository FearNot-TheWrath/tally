# Wall Suite Handoff (2026-06-01)

## Status

- **Phase 1 shipped and live at `https://tally.thelopezfamily.org/wall`.**
- Tagged `v0.12.0-wall-suite-1` on master.
- Phase 2 (Google Calendar OAuth + Verse/Fact panel) is **not started**. Spec covers it.

## What the wall does right now

- **Chores panel.** Byte-for-byte the same renderer as the pre-Suite wall (banner, streak leader, 3-column kid layout, bonus strip, scrolling task marquees, confetti on milestones).
- **Weather panel.** Open-Meteo, no API key, 10-minute cache server-side. Theme-aware backgrounds (8 WMO-driven CSS classes: clear-day, clear-night, partly-cloudy, overcast, fog, rain, snow, thunderstorm) with pure-CSS rain/snow/lightning animations. 3-day forecast strip.
- **Rotation.** Chores is home base. Cycles `chores -> weather -> chores -> weather -> ...`. Default dwell: **30s chores, 15s weather** (chores dwell was bumped down from 60 per request).
- **Sleep mode.** Configurable window. Default 22:00 -> 06:00. Enters by clearing the wall, painting body black, mounting a centered drifting dim clock that re-positions every 60s. Three clock styles: `digital`, `analog-minimal` (default), `analog-classic`.
- **Theme.** Detects `prefers-color-scheme` and sets `data-theme` on `<html>`. Matches the legacy wall's behavior; no forced dark.
- **Persistent clock.** The `.wall-header .t` text element is updated every second so the time keeps ticking across panel switches without re-rendering the whole DOM.

## Live state on the box (as of handoff)

- PM2 process `tally`, port 3012.
- Cloudflare Tunnel: `tally.thelopezfamily.org` -> 3012.
- DB live: `~/projects/tally/tally.db` (SQLite).
- Wall location set to Hutto, TX: `wall_weather_lat=30.5083`, `wall_weather_lon=-97.5469`, `wall_weather_unit=F`.

## Settings keys (in `settings` table, all whitelisted in `EDITABLE_KEYS`)

| key | default | notes |
|---|---|---|
| `wall_enabled_panels` | `chores,weather,calendar,verse-fact` | comma list. Phase 1 only renders `chores` and `weather`; unknown keys silently skipped at parse time |
| `wall_chores_dwell_sec` | `30` (was migrated as 60, set live to 30) | int 5..600 |
| `wall_other_dwell_sec` | `15` | int 5..600 |
| `wall_weather_lat` | `30.5083` | number -90..90 or empty |
| `wall_weather_lon` | `-97.5469` | number -180..180 or empty |
| `wall_weather_unit` | `F` | `F` or `C` |
| `wall_sleep_start` | `22:00` | HH:MM |
| `wall_sleep_end` | `06:00` | HH:MM |
| `wall_sleep_clock_style` | `analog-minimal` | `digital`, `analog-minimal`, `analog-classic` |

All configurable from admin Settings -> Wall Suite card group.

## Files of interest

### Active runtime
```
public/wall.html                    legacy structure (<div id="wall">) — DO NOT change
public/js/pages/wall.js             single-file renderer; chores + weather + sleep + rotation
public/js/wall/rotation.js          Rotation class (tested)
public/js/wall/sleep.js             isInSleepWindow (tested)
public/css/wall-suite.css           weather themes, sleep-face, weather body layout
src/routes/wall.js                  /api/wall (chores), /api/wall/config, /api/wall/weather, /api/wall/events
src/lib/wall/open-meteo.js          Open-Meteo client + WMO -> theme mapping (tested)
src/migrations/012-wall-suite.sql   seeds default settings keys
```

### Spec + plan (for future Phase 2 and refactors)
```
docs/superpowers/specs/2026-06-01-tally-wall-suite-design.md
docs/superpowers/plans/2026-06-01-tally-wall-suite-phase1.md
```

### Removed (during regression fix)
The Phase 1 plan originally introduced a `#wall-root` / `#wall-stage` outer container with absolutely-positioned `.wall-panel` children for cross-fade transitions. That structure rendered invisibly on Edge for the user, even though content was in the DOM. Reverted to the legacy `<div id="wall">` structure with a flat `.wall-page` flex column, all in one render flow inside `public/js/pages/wall.js`. The following modules were deleted in commit `f275924`:
```
public/js/wall/stage.js
public/js/wall/header.js
public/js/wall/sleep-clock.js
public/js/wall/panels/chores.js
public/js/wall/panels/weather.js
```
If we ever want the panel-orchestrator architecture back, it's in git history at `a630d6b..695bf21`.

## What the rotation actually looks like

```
chores 30s -> weather 15s -> chores 30s -> weather 15s -> ...
```

`Rotation.advance()` walks the cursor through enabled non-chores panels in order. Adding calendar / verse-fact later (Phase 2) extends the cycle:
```
chores -> weather -> chores -> calendar -> chores -> verse-fact -> chores -> weather -> ...
```

If a panel's `fetch()` returns `{ skip: true }`, the rotation silently advances. Weather skips when:
- lat/lon not set (`skip: true, reason: 'no location configured'`)
- Open-Meteo fetch has been failing for >30 min with no cached success (`skip: true, reason: 'fetch failed'`)

## Known issues / open polish

1. **Weather panel typography.** Just confirmed renders correct values (92°F, theme background, day labels) but the visual is barebones. The big temp is `14vh`, forecast strip is centered flex. May want better hierarchy, a condition string ("Sunny", "Partly cloudy"), maybe an animated condition icon larger than the emoji.
2. **Weather emoji icons.** Currently uses Unicode `☀⛅☁🌫🌧❄⛈☾`. Edge may render these as text rather than colored emoji depending on installed fonts. If they look bad on the Pi, swap to an SVG icon set (1 SVG per theme).
3. **No bonus alerts on the wall when bonus board is empty.** Cosmetic; existing behavior from pre-Suite.
4. **SSE only refreshes when the active panel is chores.** Switching to weather during a milestone confetti event means we miss the confetti until the next chores visit. Acceptable but worth noting.
5. **Sleep clock drift can land on the same spot.** `Math.random()` based; over 60s ticks the chance is non-zero but visually fine.

## Phase 2 — Calendar + Verse/Fact (not started)

Spec is in `docs/superpowers/specs/2026-06-01-tally-wall-suite-design.md`. Highlights:

- **Calendar** via Google OAuth (admin "Connect Google Calendar" button in Settings). Stores refresh token AES-256-GCM encrypted with key derived from `SESSION_SECRET`. Multi-calendar select, color dots per source. Window: today + next 3 days. Skip when today+24h is empty.
- **Verse/Fact** panel. Curated JSON files in repo:
  - `data/verses-nabre.json` — 365 NABRE verses, day-of-year indexed
  - `data/facts.json` — ~100 family-friendly fun facts, rotated by `(dayOfYear % length)`
  - Alternates: even day-of-year -> verse, odd -> fact.
- The current single-file `wall.js` will need restructuring before Phase 2 lands; right now it inlines chores + weather renders. Adding calendar + verse-fact inline is fine if we accept a 600-line file, OR we split into a small panels module (cleaner). Decision deferred to start of Phase 2.

## Commands cheat sheet

```bash
# restart wall after a change
cd ~/projects/tally && pm2 restart tally --update-env

# tail logs
pm2 logs tally --lines 30 --nostream

# run full test suite (265 tests as of handoff)
cd ~/projects/tally && npm test

# read current wall config
curl -s https://tally.thelopezfamily.org/api/wall/config | jq .

# read current weather
curl -s https://tally.thelopezfamily.org/api/wall/weather | jq .

# change a setting from CLI (e.g. force sleep mode for a quick test)
node -e "import('better-sqlite3').then(({default:D})=>{const d=new D('./tally.db');d.prepare(\"UPDATE settings SET value=? WHERE key=?\").run('06:00','wall_sleep_start');})"
```

## Lessons learned (process notes for next time)

1. **Smoke test in a real browser before claiming UI work is done.** The Phase 1 plan's smoke step was "do this yourself later." Two of the bugs that bit (enabled_panels string vs array, weather field-name mismatches, the structural Edge regression) would have surfaced in 30 seconds of manual page-load.
2. **Match the legacy DOM when refactoring something that already works.** The cross-fade panel architecture was elegant on paper and broken in practice on the user's browser. The legacy `<div id="wall">` + flat render shipped and renders the same on every browser the original wall did.
3. **Bug at API boundary: `/api/wall/config` returns `enabled_panels` as a STRING (comma list).** The renderer needs to parse it. Worth documenting at the route level too.

## Restoration / rollback path

If the wall ever breaks again and we need the pre-Suite version live in 30 seconds:

```bash
cd ~/projects/tally && \
  git show v0.11.0-finish-the-list:public/wall.html > public/wall.html && \
  git show v0.11.0-finish-the-list:public/js/pages/wall.js > public/js/pages/wall.js && \
  pm2 restart tally --update-env
```

(Server routes and migrations stay; only the page wiring rolls back.)
