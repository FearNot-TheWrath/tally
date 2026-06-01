# Tally Wall Suite — Design Spec

**Date:** 2026-06-01
**Status:** Approved for plan-writing
**Target releases:** v0.12.0-wall-suite-1 (Phase 1), v0.13.0-wall-suite-2 (Phase 2)

## Summary

Turn the single-purpose chores wall at `/wall` into a multi-panel **Wall Suite** designed to run on a Raspberry Pi kiosk display in the family living space. Panels rotate in a smart, chores-heavy cycle. Adds Weather, Calendar (via Google OAuth), and a Verse/Fact panel. Includes a configurable overnight sleep mode with a drifting, dim clock face to prevent burn-in while keeping a glance-clock visible at night.

## Goals

- Keep the existing chores wall as the "home base" of the rotation. No regression in current wall behavior.
- Add three new panels (Weather, Calendar, Verse/Fact) that visit briefly between chores cycles.
- Make every new external dependency cached server-side so the Pi never hits external APIs directly.
- Configurable from the existing Tally admin Settings tab. No new admin surface.
- Burn-in safe by default on LCD/IPS displays. Pure-CSS animations only; no canvas, no per-frame JS.
- Each panel ships behind a stable, tiny interface so adding panels later (e.g. USCCB readings, photos, sports scores) is mechanical.

## Non-goals

- Hardware-level display blanking (cron + `vcgencmd display_power`). Listed as v2.
- Live USCCB Mass-readings-of-the-day. Verse/Fact v1 uses curated JSON. v2 idea.
- Touch / remote interactivity on the wall itself. Pure auto-rotation.
- Per-kid private calendars. Calendars are family-wide.
- Building a Roku channel. (See session note.)

## Architecture

The wall remains a separate HTML page (`public/wall.html`) outside the main SPA, served by Express. Inside, it becomes a **stage** that hosts panels.

```
+-----------------------------------------------------------+
| Persistent header: clock + date + tiny streak leader badge |
+-----------------------------------------------------------+
|                                                           |
|                                                           |
|                   ACTIVE PANEL VIEWPORT                   |
|                                                           |
|                                                           |
+-----------------------------------------------------------+
```

The header is always visible during waking hours so the screen never feels fully empty. The viewport is occupied by one panel at a time, with a 400ms cross-fade between panels.

### Panel interface

Every panel module under `public/js/wall/panels/` exports a small object:

```js
export default {
  key: 'weather',                 // unique, matches settings value
  async fetch() { ... },          // returns { data, skip?: boolean }
  mount(host, data) { ... },      // render into the host element
  unmount() { ... },              // tear down timers, listeners
  refresh(data) { ... },          // optional; called when SSE fires
};
```

`fetch()` is called once before each rotation slot. If it returns `{ skip: true }`, the stage advances to the next panel immediately (chores never skips). This is how "no calendar events today" or "weather API failed for 30+ min" surface — silently, not via an error state.

`mount(host, data)` renders into the host element. `unmount()` is mandatory and must clean up any `setInterval`/`setTimeout` / SSE / DOM listeners the panel created. The stage will not call `unmount` if the panel didn't `mount` first.

`refresh(data)` is optional. The chores panel uses it to react to SSE `refresh` events without a full unmount/mount cycle, preserving confetti animations.

### Stage orchestrator

`public/js/wall/stage.js`:

- Maintains the active panel pointer and the next-other-panel cursor.
- Runs the rotation timer with intervals from settings.
- Owns SSE connection lifecycle; calls active panel's `refresh()` on event.
- Owns sleep-mode lifecycle: paints viewport black, hides header, stops timers/SSE, mounts the sleep clock.
- Owns the persistent header. Updates clock every second via one shared `setInterval`.

### Server routes

```
GET /wall                         (existing)  chores panel data
GET /wall/events                  (existing)  SSE
GET /api/wall/weather             (new)       Open-Meteo proxy + cache
GET /api/wall/calendar            (new)       Google Cal merged events
GET /api/wall/verse-fact          (new)       day-indexed verse + fact
GET /api/wall/config              (new)       enabled panels, dwell times, sleep
                                              window, clock style — read-only
GET /auth/google/start            (new)       OAuth init
GET /auth/google/callback         (new)       OAuth callback handler
```

`/api/wall/config` exists so the stage can read its settings without hitting the admin API (no auth needed for the wall).

## Rotation: the smart cycle

Chores is home base. Other panels visit briefly.

```
chores 60s -> [next other] 15s -> chores 60s -> [next other] 15s -> ...
```

The "next other" cursor walks the enabled non-chores panels in stable order: `weather -> calendar -> verse-fact -> weather -> ...`. With all three enabled the wall pattern is:

```
chores  weather  chores  calendar  chores  verse-fact  chores  weather  ...
```

A panel that returns `skip: true` from `fetch()` is silently passed over and the cursor advances. If `chores` is the only enabled panel, the stage never rotates.

Three knobs in settings control all behavior:
- `wall_chores_dwell_sec` (default 60)
- `wall_other_dwell_sec` (default 15)
- `wall_enabled_panels` (default `chores,weather,calendar,verse-fact`)

## Panels

### Chores

The existing `/wall` view, refactored to live behind the panel interface. No functional change. Streak leader, kid cards, today's chore counts, confetti on milestone all preserved. The persistent header takes over the clock + date that the current wall renders, so the panel itself loses that top strip.

### Weather

**Source:** Open-Meteo `forecast` endpoint. No API key. The route reads `wall_weather_lat`/`wall_weather_lon` from settings; if either is unset, the panel returns `skip: true` (and the admin Settings UI shows a "Set location to enable" hint).

**Cache:** 10-minute in-memory cache keyed by `${lat},${lon}`. Cache miss makes one HTTPS call; result reused.

**Skip rule:** If the API has been failing for over 30 minutes (no successful fetch in that window), `fetch()` returns `skip: true` rather than display stale data.

**Display:**
- Current temp + condition icon
- Today's high/low
- 3-day forecast strip (icon + high/low per day)
- Unit (F/C) from `wall_weather_unit`

**Background treatment.** WMO weather code + sunrise/sunset time map to one of these themes via CSS class on the panel root:

```
clear-day       warm yellow-to-blue gradient
clear-night     deep indigo, scattered dot stars
partly-cloudy   soft blue with cloud silhouettes
overcast        flat slate grey
rain            cool blue/grey, falling-droplet animation
thunderstorm    dark navy with periodic flash overlay
snow            pale grey/white, falling-flake animation
fog             low-contrast grey wash
```

All animations are pure CSS (gradient drift via `@keyframes`, droplets via `::before`/`::after` pseudo-element layers, flash via opacity keyframes). No canvas, no JS loops. Tasteful, not loud. Text contrast checked against each theme at build time.

### Calendar

**Source:** Google Calendar API v3, via Google OAuth.

**OAuth setup:**
- One-time admin action: open Settings tab, click "Connect Google Calendar".
- Browser redirected to Google OAuth consent (`scope=https://www.googleapis.com/auth/calendar.readonly`).
- Server callback receives the auth code, exchanges for tokens, stores the refresh token in `settings.wall_calendar_oauth_refresh` (AES-256-GCM encrypted with key derived from `SESSION_SECRET`).
- After consent, server fetches the user's calendar list and shows a multi-select; selection is saved to `settings.wall_calendar_selected_ids` (comma list of Google `calendarId` values). The color hex for each selected calendar is cached alongside (`wall_calendar_colors` — JSON map).

**Token lifecycle:** Access tokens are short-lived; we don't store them. On each call to `/api/wall/calendar` we exchange the refresh token for a fresh access token (cached in memory for its `expires_in` lifetime). If a refresh fails with `invalid_grant`, we log it, clear the stored refresh token, and the panel starts returning `skip: true` until the admin re-connects.

**Cache:** 5-minute in-memory cache on the merged events list. Cache miss makes one Google API call per selected calendar.

**Display window:** today + the next 3 days.

**Layout:**
- Hero row for today's next upcoming event (large title, time, location if present, color dot).
- Compact list below for the rest of today.
- All-day events sit in a slim header strip above the timed events.
- Past events from today auto-grey out via a CSS class set when `event.end < now`.
- Tomorrow / day-after / day-after-that get one-line rows further down.
- Color dot per row from the calendar's stored hex.

**Skip rule:** If today and the next 24 hours have zero events, the panel returns `skip: true`. Otherwise it displays the full today + 3-day window (events beyond 24h are shown when present, but their absence alone doesn't trigger skip).

### Verse/Fact

**Source:** two curated JSON files in the repo:
- `data/verses-nabre.json` — 365 NABRE verse entries indexed by day-of-year (`{ "001": { ref, text }, ... }`)
- `data/facts.json` — ~100 family-friendly fun facts in a flat array, rotated by `(dayOfYear % length)`

No external API in v1. No rate limits, no outages, no scraping concerns. Files are committed to the repo and reviewed before merge.

**Display:**
- On even-numbered days of the year (`dayOfYear % 2 === 0`): verse panel (verse text large, reference smaller below).
- On odd days: fact panel (fact text large, decorative iconography).
- One JSON-driven panel, two layouts.

**Never skips** in v1 — the data is local.

**v2 idea (not in this spec):** swap the verse source for live USCCB daily Mass readings via their feed. Catholic liturgical-calendar-aware. Out of scope here.

### Persistent header

Top strip, visible during waking hours regardless of which panel is active:

```
[HH:MM AM/PM]                Tuesday, June 1            [Streak leader: Gabriel 7d]
```

Clock updates every second via a single shared `setInterval`. Streak leader is read from the existing `/wall` response (already computed). Streak leader segment is omitted if no kid has an active streak.

## Sleep mode

**Trigger:** server time falls within `[wall_sleep_start, wall_sleep_end]` (HH:MM, wraps across midnight). Checked every 60 seconds by a stage interval.

**On enter:**
- Stage clears the viewport and the header.
- Paints `body { background: #000 }`.
- Stops the rotation timer.
- Closes the SSE connection.
- Calls `unmount()` on the active panel.
- Mounts the sleep clock module (`public/js/wall/sleep-clock.js`).

**Sleep clock module:**
- Picks one of three styles from `wall_sleep_clock_style`:
  - `digital` — large HH:MM, ~25vh tall, 12% white opacity
  - `analog-minimal` — thin tick marks at 12 hour positions, no numerals, thin hour/minute hands, no second hand, 12% white opacity, ~30vh diameter
  - `analog-classic` — same as minimal plus `12 3 6 9` numerals at cardinals
- Repositions itself to a new random `(x, y)` within the safe inset (no closer than 15% to any edge) every 60 seconds, with a 3s ease transition.
- Updates the displayed time every second (digital) or hand positions (analog) via one shared `setInterval`.

**On exit (current time >= `wall_sleep_end`):**
- Unmounts sleep clock.
- Restores `body` background.
- Restarts rotation from the chores panel.
- Reopens SSE.

**Why no `display_power 0`?** Sleep mode on an LCD with pure black + slow-moving 12%-opacity content is functionally equivalent to a screensaver. Hardware blanking adds OS-level dependencies (Pi OS X11 vs Wayland diverge here) and a coordination problem (Pi shell script reading Tally settings). Not worth it in v1. Punt to v2 as an optional add-on.

## Settings additions

All new keys live in the existing `settings` table, whitelisted in `EDITABLE_KEYS` and `READABLE_KEYS` in `src/routes/admin/settings.js`:

```
wall_enabled_panels            "chores,weather,calendar,verse-fact"
wall_chores_dwell_sec          60
wall_other_dwell_sec           15
wall_weather_lat               (unset until admin configures)
wall_weather_lon               (unset until admin configures)
wall_weather_unit              "F"
wall_calendar_oauth_refresh    (encrypted blob; set by OAuth callback)
wall_calendar_selected_ids     "" (comma list of calendarIds)
wall_calendar_colors           "{}" (JSON map calendarId -> hex)
wall_sleep_start               "22:00"
wall_sleep_end                 "06:00"
wall_sleep_clock_style         "analog-minimal"
```

Validation rules in the PATCH handler:
- `wall_enabled_panels`: comma-separated subset of the known panel keys; chores must be present if any are.
- `wall_chores_dwell_sec`, `wall_other_dwell_sec`: integer 5..600.
- `wall_weather_lat`: number -90..90 or empty.
- `wall_weather_lon`: number -180..180 or empty.
- `wall_weather_unit`: "F" or "C".
- `wall_sleep_start`, `wall_sleep_end`: HH:MM 00:00..23:59.
- `wall_sleep_clock_style`: one of `digital`, `analog-minimal`, `analog-classic`.

Migration NNN seeds defaults on existing installs.

### Settings UI

New "Wall Suite" card group in the Settings admin tab, below the existing payout/photo retention cards:

- **Panels enabled** — four checkboxes (chores checkbox disabled-but-checked, others toggleable). Writes back to `wall_enabled_panels`.
- **Rotation timing** — two number inputs (chores dwell sec, other dwell sec).
- **Weather** — two inputs (lat, lon) plus a unit dropdown plus a "Test" button that calls `/api/wall/weather` and shows the current conditions inline.
- **Calendar** — if not connected: a "Connect Google Calendar" button. If connected: shows the chosen calendars with delete + "Re-pick calendars" + "Disconnect" actions.
- **Sleep mode** — two time inputs + a clock-style radio group.

All settings save inline on change (matching existing pattern), with the green border flash.

## Error handling

- **Open-Meteo failure**: 30-min skip-the-panel rule. Logged to stderr. No user-facing error.
- **Google API failure**: 5-min skip-the-panel rule. If `invalid_grant` on refresh, refresh token cleared and panel disabled until reconnected.
- **OAuth callback failure**: redirect back to Settings with a `?wall_calendar_error=...` query param; Settings UI surfaces a banner.
- **Verse/Fact JSON missing or malformed**: panel returns `skip: true`. App boot does not fail. (Tests cover this.)
- **SSE reconnect**: stage retries SSE every 30s with exponential backoff capped at 5min, exactly matching the current `/wall` page logic. No change to chores-side behavior.
- **Sleep mode clock crash**: caught at the stage level; falls back to plain `#000` viewport. Logged.

## Testing

Unit tests:
- `tests/lib-wall-rotation.test.js` — rotation cursor walks correctly, honors `skip: true`, advances on chores-only edge case (never rotates), respects disabled panels.
- `tests/lib-wall-sleep.test.js` — sleep-window logic (including midnight wrap), clock-style selection.
- `tests/lib-wall-weather.test.js` — Open-Meteo response mapping to WMO theme + display fields, cache hit/miss, 30-min skip rule.
- `tests/lib-wall-calendar.test.js` — token-refresh path (fixtured), merge across calendars, today+72h window selection, skip-when-empty rule.
- `tests/lib-wall-verse-fact.test.js` — day-of-year indexing, missing-file fallback, even/odd alternation.

Route tests:
- `tests/routes-wall-weather.test.js` — endpoint returns mapped data, returns 503 on persistent failure.
- `tests/routes-wall-calendar.test.js` — endpoint returns merged events, returns empty list (not error) when not configured.
- `tests/routes-wall-verse-fact.test.js` — endpoint deterministic for a given date.
- `tests/routes-wall-config.test.js` — endpoint returns the public subset of settings (no encrypted refresh token).
- `tests/routes-admin-settings.test.js` — new validations for each new key (boundary cases).

Manual verification (documented in spec but not automated):
- Open `/wall` on the Pi. Watch the rotation cycle through chores -> weather -> chores -> calendar -> chores -> verse -> ... at the configured intervals.
- Toggle a panel off in Settings, see it dropped from rotation within ~60s.
- Set sleep window to a 2-minute future window; watch the wall enter sleep, drift the clock, exit.
- Disconnect from Google Cal in Settings; watch calendar panel become skipped.

## Phasing

**Phase 1 — Scaffold + Chores + Weather (v0.12.0-wall-suite-1)**
1. Migration: new settings keys with defaults.
2. Settings whitelist + validators.
3. Stage orchestrator (`public/js/wall/stage.js`).
4. Panel interface contract documented as code comments on stage.js.
5. Sleep mode + three clock styles.
6. Persistent header.
7. Chores panel port (no behavior change).
8. Weather route + Open-Meteo client + cache.
9. Weather panel + 8 theme classes + animations.
10. `/api/wall/config` route.
11. Settings admin UI for everything Phase 1 owns.
12. All Phase 1 tests.
13. Tag v0.12.0-wall-suite-1, push.

**Phase 2 — Calendar + Verse/Fact (v0.13.0-wall-suite-2)**
1. Google OAuth client setup (Google Cloud project creation steps documented).
2. OAuth start + callback routes.
3. Encryption helper for refresh-token storage.
4. Calendar list + selection UI in Settings.
5. Calendar route + token refresh + merge.
6. Calendar panel.
7. Verse + fact JSON files committed.
8. Verse/Fact route + panel (one route, two layouts).
9. Phase 2 tests.
10. Tag v0.13.0-wall-suite-2, push.

Phase 1 ships a useful wall on its own. Phase 2 is fully additive.

## Files touched

**Phase 1 (new):**
```
src/migrations/NNN-wall-suite.sql
src/routes/wall/weather.js
src/routes/wall/config.js
src/lib/wall/open-meteo.js
src/lib/wall/rotation.js
src/lib/wall/sleep.js
public/js/wall/stage.js
public/js/wall/panels/chores.js
public/js/wall/panels/weather.js
public/js/wall/sleep-clock.js
public/css/wall-suite.css
data/.gitkeep
tests/lib-wall-rotation.test.js
tests/lib-wall-sleep.test.js
tests/lib-wall-weather.test.js
tests/routes-wall-weather.test.js
tests/routes-wall-config.test.js
```

**Phase 1 (modified):**
```
public/wall.html
public/js/pages/wall.js                (gets thinner; logic moves to stage.js + chores.js)
public/js/pages/admin.js               (Settings UI additions)
src/routes/admin/settings.js           (whitelist + validators)
src/app.js                             (mount new wall routes)
```

**Phase 2 (new):**
```
src/routes/wall/calendar.js
src/routes/wall/verse-fact.js
src/routes/auth/google.js
src/lib/wall/google-cal.js
src/lib/crypto-settings.js
public/js/wall/panels/calendar.js
public/js/wall/panels/verse-fact.js
data/verses-nabre.json
data/facts.json
tests/lib-wall-calendar.test.js
tests/lib-wall-verse-fact.test.js
tests/lib-crypto-settings.test.js
tests/routes-wall-calendar.test.js
tests/routes-wall-verse-fact.test.js
tests/routes-auth-google.test.js
```

**Phase 2 (modified):**
```
src/app.js                             (mount calendar/verse-fact/oauth routes)
public/js/pages/admin.js               (Calendar UI additions)
src/routes/admin/settings.js           (additional validators)
.env.example                           (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)
README.md                              (OAuth setup steps)
```

## Open decisions deferred to plan-writing

- Exact crypto choice for the OAuth refresh token (AES-256-GCM with `crypto.scryptSync(SESSION_SECRET, salt, 32)` is the working assumption; revisit in plan if there's a simpler equivalent).
- Whether the persistent header dims slightly during the verse/fact panel for emphasis (small visual call).
- WMO code -> theme mapping table exact contents (will be inlined in `open-meteo.js`).

## Out of scope (explicit)

- Hardware-level display blanking via `vcgencmd`.
- USCCB live readings.
- Touch / remote / motion-sensor interactivity.
- Per-kid private calendars.
- Multi-location weather.
- Configurable color theming of panels beyond what the WMO weather codes already drive.
- Spotify embed or any music feature. (Roku channel discussion noted.)
