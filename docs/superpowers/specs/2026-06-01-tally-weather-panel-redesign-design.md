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

A precipitation radar layer fills the open body area and sits behind the weather content (`z-index` below the content layer). Treatment:

- Fades in from the top with a CSS mask (`linear-gradient(to bottom, transparent 0%, #000 ~22%, #000 100%)`) so it never competes with the hero text.
- Blended into the theme gradient with `mix-blend-mode: screen` so the dark map base drops out and only precipitation echoes glow through.
- Opacity around 0.5 to 0.55, tunable.
- A small "Live radar" tag in the corner.
- When there is no precipitation the backdrop is nearly invisible (truthful); during storms it lights up behind the numbers.

**Radar source.** To get the clean "precipitation over the gradient" look (no muddy land/county base map), prefer a transparent radar source over the NWS composite GIF. Implementation will validate, in order of preference:

1. A single transparent radar image for a bounding box centered on the configured lat/lon (for example an NWS GeoServer/nowCOAST WMS `GetMap` PNG with `transparent=true`). One `<img>`, no map library.
2. If a clean single-image transparent product is not readily available, fall back to the **NWS RIDGE composite loop GIF** (verified working: `https://radar.weather.gov/ridge/standard/KEWX_loop.gif`, ~290KB animated, base map baked in) blended with `screen`.

This source choice is a small contained spike at the start of implementation. Either way the panel renders; radar is decorative and degrades gracefully (see Error handling).

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
| `wall_radar_station` | `KEWX` | NWS RIDGE station id, used if the GIF-fallback source is selected |

Both added via a new migration `013-weather-radar.sql` and whitelisted in `EDITABLE_KEYS`, configurable from the admin Settings Wall Suite card group. Existing weather keys are unchanged.

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
public/wall.html                 add wall-suite.css <link> (after layouts.css)
public/js/pages/wall.js          rewrite renderWeather(): hero + curve + metrics + radar backdrop
public/css/wall-suite.css        hero/curve/metrics/radar-backdrop styles; @font-face color emoji
src/lib/wall/open-meteo.js       expand request; richer parseForecast; wmoToText helper
src/routes/wall.js               surface new current/hourly/daily fields on /api/wall/weather; radar source/url
src/migrations/013-weather-radar.sql  seed wall_weather_radar, wall_radar_station (+ EDITABLE_KEYS)
public/css/ (assets)             self-hosted color emoji webfont
test/...                         parseForecast + wmoToText unit tests
```
