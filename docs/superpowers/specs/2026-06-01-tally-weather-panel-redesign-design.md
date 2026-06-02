# Tally Wall: Weather Panel Redesign (Direction B + radar backdrop)

**Date:** 2026-06-01
**Status:** Design approved, ready for implementation plan
**Supersedes:** the weather portions of `2026-06-01-tally-wall-suite-design.md` (Phase 1 weather). The rotation, sleep, and chores work from that spec stand unchanged.

## Problem

The shipped weather panel looks barebones: a small current temp, a one line H/L, and a 3-day strip of monochrome glyphs on a flat white background. The user compared it to MSN and weather.com and asked for a richer, more polished look.

Two findings during exploration explain most of it:

1. **`wall-suite.css` is never loaded.** `public/wall.html` links `tokens.css`, `base.css`, `components.css`, and `layouts.css`, but not `wall-suite.css`. Every gradient theme and the rain/snow/lightning/stars animations built in Phase 1 sit on disk unused, so `.wall-page` falls back to `background: var(--bg)` (white) and the icons render as plain glyphs. The flat white look is a missing `<link>`, not a design choice.
2. **The data is thin.** `src/lib/wall/open-meteo.js` only requests `temperature_2m, weather_code, is_day` (current) and `weather_code, temperature_2m_max/min, sunrise, sunset` (daily). There is no apparent temperature, humidity, wind, hourly series, precipitation probability, or condition text to render a richer panel.

## Goals

- A polished, glanceable weather panel readable from across the room in the ~15s it is on screen.
- Richer data from Open-Meteo (still no API key): condition text, feels-like, humidity, wind, an hourly temperature curve, and precipitation chance.
- Live precipitation radar woven in as a faded backdrop behind the weather content.
- Fix the missing stylesheet so the existing gradient themes and weather animations actually render.

## Non-goals

- Moon phase, air quality, UV breakdown panels, news, multiple locations. (Feels-like, humidity, wind, rain chance, and sunrise/sunset are the only secondary metrics in scope.)
- A separate radar rotation panel. Radar lives inside the weather panel as a backdrop, so `enabled_panels` and the rotation are unchanged.
- Touching chores, sleep, or rotation logic.

## Chosen design: "Direction B" with a radar backdrop

Approved visually via the brainstorm companion. Layout, top to bottom, inside the existing `.wall-page` flex column:

1. **Header** (unchanged structure): "The Lopez House" plus the live ticking date/time.
2. **Hero row:** large condition emoji, large current temperature, condition word ("Sunny"), and a subline `Feels 97° · H 92° L 73°`. A 3-day forecast strip is pushed to the right edge (day, icon, hi/lo, precip %).
3. **Hourly curve:** an inline SVG polyline of temperature for the next 12 hours, with a marker dot and a sunrise/sunset glyph, plus a row of sparse hour labels beneath (`Now 91° · 8p 86° · 🌙 8:27 · 6a 73°`).
4. **Metrics strip** along the bottom: four cells, **Humidity · Wind · Rain chance · next Sunrise/Sunset**, on a faint translucent dark bar so they stay legible over the radar.

### Radar backdrop

> **Revised during implementation (2026-06-01).** The original plan tried the NWS RIDGE composite GIF, but its baked-in gray county base map went muddy under `mix-blend-mode: screen` and could not be centered on Hutto. After visual review with the user we switched to a small **Leaflet** map. This is the shipped approach.

A precipitation radar layer fills the open body area and sits behind the weather content (`z-index` below the content layer). It is a **non-interactive Leaflet map** (vendored locally at `public/vendor/leaflet/`, no CDN, no API key), centered on the configured weather lat/lon at zoom 8, composed of:

- **Faint dark base map** — CARTO `dark_nolabels` tiles at ~0.4 opacity, giving subtle state/county outlines for geographic context (replaces the muddy NWS map).
- **Animated precipitation** — RainViewer transparent radar tiles (`api.rainviewer.com`, CORS-open, no key), cycling the last ~13 frames (~2 hours) on a ~600ms interval at ~0.9 opacity. Frames are fetched client-side.
- **"You are here" dot** — a pulsing blue Leaflet `divIcon` marker at the home coordinates.
- **Edge fade** — the whole map container is masked with a radial vignette (`radial-gradient(135% 118% at 50% 40%, #000 56%, transparent 100%)`) so it melts into the gradient on all four edges.
- A small "Live radar" tag and a tiny "CARTO · RainViewer" attribution.
- When there is no precipitation the rain layer is nearly empty (truthful); the dark base + dot still anchor the view. During storms the echoes light up.

The map is non-interactive (all gestures and controls disabled) and self-healing: any Leaflet/RainViewer error leaves the gradient panel intact. The animation interval and map instance are torn down on every panel re-render so they never stack across rotations.

The server only tells the client whether radar is enabled and where to center it; the client builds the map and fetches frames. Radar is decorative and degrades gracefully (see Error handling).

## Data layer changes (`src/lib/wall/open-meteo.js`)

Expand the Open-Meteo request:

- `current`: add `apparent_temperature, relative_humidity_2m, wind_speed_10m` (keep `temperature_2m, weather_code, is_day`).
- `hourly`: `temperature_2m, weather_code, is_day, precipitation_probability`.
- `daily`: add `precipitation_probability_max` (keep `weather_code, temperature_2m_max, temperature_2m_min, sunrise, sunset`).
- Add `wind_speed_unit=mph` when the unit setting is `F` (`kmh` for `C`).

`parseForecast(json)` returns a richer object:

```
{
  current_temp, apparent_temp, humidity, wind, wind_unit,
  condition,        // text label, day/night aware
  theme, is_day,
  today_high, today_low, today_precip,
  sunrise, sunset,  // ISO; render as local time and pick whichever is "next"
  hourly: [ { time, temp, code, is_day, precip_prob } x next 12 ],
  forecast: [ { day_iso, theme, code, condition, high, low, precip } x 3 ]
}
```

The hourly slice starts at the current hour and takes the next 12 entries.

### Condition text map

A new WMO-code-to-text map (a sibling of the existing `THEME_BY_CODE`), day/night aware for clear sky ("Sunny" by day, "Clear" by night). Examples: 0/1 -> Sunny/Clear, 2 -> Partly cloudy, 3 -> Overcast, 45/48 -> Fog, 51-57 -> Drizzle, 61-67 -> Rain, 71-77 -> Snow, 80-82 -> Rain showers, 95-99 -> Thunderstorms. Exposed as a `wmoToText(code, isDay)` helper alongside `mapWmoToTheme`.

## Icons: emoji, with guaranteed color

The user chose to keep emoji glyphs rather than a custom SVG set. To prevent the monochrome fallback seen on the Pi/Edge, bundle a self-hosted color emoji webfont via `@font-face` (served locally so it works without relying on whatever font the Pi has installed) and apply it to the weather icon elements. Add the `U+FE0F` emoji-presentation selector to the glyphs. The existing theme-to-glyph map is reused and extended (day/night clear: ☀️ / 🌙).

## Wiring and theme fix

- Add `<link rel="stylesheet" href="/css/wall-suite.css">` to `public/wall.html`, **after** `layouts.css` so `.weather-theme-*` wins the cascade over `.wall-page { background: var(--bg) }`.
- Extend `public/css/wall-suite.css` with the hero layout, hourly curve, metrics strip, and radar-backdrop styles. The existing gradient themes and rain/snow/lightning/stars animations light up for free once the file is linked.

## Settings keys (additions)

| key | default | notes |
|---|---|---|
| `wall_weather_radar` | `on` | `on`/`off`; toggles the radar backdrop |

Added via migration `013-weather-radar.sql` and whitelisted in `EDITABLE_KEYS`, with an on/off control in the admin Settings Wall Suite card group. Radar centers on the existing `wall_weather_lat`/`wall_weather_lon`, so no separate station/center key is needed. (An early draft added `wall_radar_station` for the NWS-GIF approach; it was dropped when radar moved to Leaflet.)

## Error handling

- The richer `parseForecast` tolerates missing/short arrays (empty `hourly`, fewer than 3 daily entries) and rounds/falls back to safe values, matching current behavior.
- `/api/wall/weather` keeps its existing skip semantics: skip when no lat/lon configured, and skip after >30 min of fetch failure with no cached success.
- **Radar is decorative.** If the radar source 404s, errors, or `wall_weather_radar` is `off`, the backdrop layer simply is not rendered and the weather panel shows normally on its gradient. Radar never blocks or skips the weather panel.

## Testing

- Unit tests for `parseForecast`: new fields populated; F vs C with correct `wind_unit`; the 12-entry hourly slice; graceful handling of empty/short `hourly` and `daily`.
- Unit tests for `wmoToText`: representative codes, and day vs night for clear sky.
- Run via the existing `npm test` suite.
- **Manual browser check (the Phase 1 lesson):** load `/wall` in a real browser, confirm the gradient renders (stylesheet now linked), emoji render in color, the hourly curve draws, the metrics strip is legible, and the radar backdrop appears and blends. Force a rainy/stormy theme to confirm radar echoes show through. Verify graceful render with radar disabled and with radar source unreachable.

## Files touched

```
public/wall.html                 link wall-suite.css (after layouts.css) + vendored Leaflet css/js
public/js/pages/wall.js          rewrite renderWeather(): hero + curve + metrics; initRadar()/teardownRadar() Leaflet backdrop
public/css/wall-suite.css        hero/curve/metrics styles; Leaflet radar container (vignette mask) + pulsing dot
src/lib/wall/open-meteo.js       expand request; richer parseForecast; wmoToText helper
src/routes/wall.js               surface new fields on /api/wall/weather; radarBlock returns {enabled, lat, lon, zoom}
src/migrations/013-weather-radar.sql  seed wall_weather_radar (+ EDITABLE_KEYS)
public/vendor/leaflet/           vendored Leaflet 1.9.4 (leaflet.js, leaflet.css)
test/...                         parseForecast + wmoToText unit tests; route radar-block assertions
```
