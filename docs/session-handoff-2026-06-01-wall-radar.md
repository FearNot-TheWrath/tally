# Wall Radar + Pi Kiosk Handoff (2026-06-01, evening)

Follows on from `docs/session-handoff-2026-06-01-wall-suite.md` (Phase 1) and the
weather redesign spec/plan in `docs/superpowers/`. This session redesigned the
weather panel, built a Pi-safe animated radar, and turned the display Pi into a
proper kiosk. Everything below is shipped, merged to `master`, and pushed.

## Status

- **Shipped and pushed to GitHub.** Tags `v0.12.1-weather-panel` (panel redesign),
  `v0.12.2-wall-radar` (server radar + kiosk), and `v0.12.3-wall-polish`
  (day/night theming + subtle bonus bar) are on `origin/master`.
- **Live** at `https://tally.thelopezfamily.org/wall`, and running as a fullscreen
  kiosk on the display Pi.
- **Next up (not started):** the Bible verse slide. See "What's next".

## What the wall does now

- **Rotation:** chores (home base) <-> weather, 30s / 15s dwell. `Rotation` class in
  `public/js/wall/rotation.js`. Sleep mode 22:00-06:00 (drifting dim clock).
- **Weather panel ("Direction B"):** hero (condition emoji + big temp + condition
  word + `Feels X · H/L`), a 12-hour SVG temperature curve with a sunrise/sunset
  marker, a metrics strip (Humidity / Wind / Rain chance / next Sunrise or Sunset),
  and a 3-day forecast pinned bottom-right. Per-theme text colors keep it readable
  day and night (white text on the dark night gradients).
- **Radar backdrop:** a server-rendered **animated WebP** played over the gradient
  (see Architecture). Toggle with the `wall_weather_radar` setting.
- **Data:** Open-Meteo (no key) via `src/lib/wall/open-meteo.js`
  (`parseForecast`, `wmoToText`); color emoji via Noto Color Emoji webfont.
- **Day/night theming (v0.12.3):** the whole wall's `data-theme` is driven by
  `is_day` from the weather data (NOT the Pi's `prefers-color-scheme`), via
  `setDayNight()`/`applyDayNightTheme()` in `wall.js`, set on boot and on every
  weather render. At night the chores slide goes dark too, so you don't get a
  blinding white flash after the dark weather slide. Light/bright by day.
- **Bonus bar (v0.12.3):** restyled from loud gold to a subtle, theme-aware amber
  tint (`color-mix(in srgb, var(--amber) N%, var(--card))` + token-based text), so
  it stays gentle in both light and dark. Bonus star uses `var(--amber)`.

## Radar architecture (the important part)

The original live **Leaflet** map (dark CARTO base + RainViewer + `mix-blend-mode:
screen` + mask) looked great but **hard-froze the 1 GB Pi 3B**: the continuous GPU
compositing, done in software on that hardware, locked the whole machine (not just
lag). Reducing frames did not help; the cost was the compositing technique, not the
animation.

**Solution: render on the server, play on the Pi.**

- `scripts/wall-radar.py` (Pillow + numpy, no browser) fetches the CARTO dark-map
  tiles + the latest RainViewer frames centered on the home coords, composites them
  into an **animated transparent WebP** (faint white map outlines + colored precip
  in RainViewer palette 4 + a "you are here" dot + baked vignette) and writes
  `public/generated/wall-radar.webp` (+ a static `.png` fallback). Atomic write
  (`.tmp` then `os.replace`).
- A **PM2 cron job `wall-radar`** regenerates it every 5 minutes
  (`--cron "*/5 * * * *" --no-autorestart --interpreter python3`). Survives reboots
  (`pm2 save`).
- The wall (`renderWeather` in `public/js/pages/wall.js`) sets the radar layer's
  `background-image` to `/generated/wall-radar.webp?cb=<5-min bucket>`. No Leaflet,
  no blend, no mask on the Pi, it just plays a finished image. Smooth on the Pi 3B.
- `radarBlock(db)` in `src/routes/wall.js` now only reports `{ enabled }`; the
  client builds the image URL. Leaflet was removed from `public/wall.html`
  (`public/vendor/leaflet/` is now unused).

`public/generated/` is gitignored (regenerating artifacts).

## The display Pi (kiosk)

- **`HSC-Living`, `HSC-Living.local` (DHCP, was .75/.77 — resolve via mDNS), user `jclopez6398`.** Raspberry Pi 3B, 1 GB RAM,
  32-bit Raspbian trixie, labwc/Wayland. Auto-login already enabled.
- **Kiosk autostart:** `~/.config/labwc/autostart` runs a self-healing loop:
  `while true; do chromium --kiosk --ozone-platform=wayland
  --app=http://192.168.1.95:3012/wall <low-mem flags>; sleep 3; done &`.
  Relaunches Chromium if it crashes; `pkill chromium` forces a refresh.
- Points at the **LAN URL** (`192.168.1.95:3012`, ~10 ms) not the domain (~300 ms),
  so the wall works even if the internet/Cloudflare is down.
- **SSH:** passwordless from acutis-box via key `~/.ssh/hsc_pi` (authorized for
  jclopez6398). SSH is enabled on the Pi.
- Claude Code **cannot run on this Pi** (arm64-only binary; this is 32-bit armv7l).
  Manage it over SSH from acutis-box.
- `packagekitd` (background updater) is still enabled; optional to disable for a bit
  more headroom (would require disabling auto security updates, so left as-is).

## Settings keys (in `settings` table)

| key | default | notes |
|---|---|---|
| `wall_enabled_panels` | `chores,weather,calendar,verse-fact` | comma list; wall.js `KNOWN` set currently only renders `chores`,`weather` |
| `wall_chores_dwell_sec` / `wall_other_dwell_sec` | `30` / `15` | int 5..600 |
| `wall_weather_lat` / `wall_weather_lon` / `wall_weather_unit` | `30.5083` / `-97.5469` / `F` | Hutto, TX |
| `wall_weather_radar` | `on` | `on`/`off` toggles the radar backdrop |
| `wall_sleep_start` / `wall_sleep_end` / `wall_sleep_clock_style` | `22:00` / `06:00` / `analog-minimal` | |

(`wall_radar_station` from an earlier draft was removed.)

## Files of interest

```
public/js/pages/wall.js          renderer: chores + weather (hero/curve/metrics/forecast) + radar image + sleep + rotation + ?debug
public/css/wall-suite.css        weather layout, gradient themes + animations, per-theme text, radar image layer
public/wall.html                 links tokens/base/components/layouts + wall-suite.css + Noto emoji (Leaflet removed)
src/lib/wall/open-meteo.js       Open-Meteo client: fetchOpenMeteo, parseForecast, wmoToText
src/routes/wall.js               /api/wall (chores), /api/wall/config, /api/wall/weather (+ radarBlock), /api/wall/events (SSE)
scripts/wall-radar.py            SERVER radar compositor -> public/generated/wall-radar.webp (PM2 cron 'wall-radar', every 5 min)
public/js/wall/rotation.js       Rotation class (tested)
public/js/wall/sleep.js          isInSleepWindow (tested)
docs/superpowers/specs/2026-06-01-tally-wall-suite-design.md   original Wall Suite spec (Calendar + Verse/Fact)
docs/superpowers/specs/2026-06-01-tally-weather-panel-redesign-design.md   weather/radar spec (radar section revised to as-built)
```

## Commands cheat sheet

```bash
# regenerate the radar image now
cd ~/projects/tally && python3 scripts/wall-radar.py
pm2 restart wall-radar            # run the generator via its PM2 job
pm2 logs wall-radar --lines 5 --nostream

# restart the app / tail logs
cd ~/projects/tally && pm2 restart tally --update-env
pm2 logs tally --lines 30 --nostream

# SSH into the display Pi (passwordless via key)
ssh -i ~/.ssh/hsc_pi jclopez6398@HSC-Living.local

# refresh the kiosk to pull new wall code (self-healing loop relaunches Chromium)
ssh -i ~/.ssh/hsc_pi jclopez6398@HSC-Living.local 'pkill chromium'

# diagnose the kiosk on the Pi
ssh -i ~/.ssh/hsc_pi jclopez6398@HSC-Living.local 'free -h; uptime; pgrep -c chromium; vcgencmd measure_temp; vcgencmd get_throttled'

# on-screen rotation debug overlay
#   open  http://192.168.1.95:3012/wall?debug   (shows build tag, panel, countdown, last error)

# full test suite (271 as of this handoff)
cd ~/projects/tally && npm test
```

## Lessons learned (do NOT relearn)

1. **A heavy browser page can hard-FREEZE the 1 GB Pi 3B** (needs a physical power
   cycle). Keep the wall light: no live maps, no `mix-blend-mode`, no continuous
   GPU/canvas work on the Pi. Bake heavy rendering on the server into an image and
   let the Pi just display it. This is THE constraint for any future wall panel.
2. **Smoke test on the actual Pi**, not just a desktop browser. The desktop hid both
   the freeze and the perf cost.
3. **Wall panels share the `.wall-header .t` clock class.** The chores
   "header-only fast-path" must guard on `root.querySelector('.wall-cols')`, or it
   updates the weather panel's clock and freezes rotation on weather.
4. **RainViewer free radar tiles cap at native zoom 7** (z8+ returns an opaque
   "Zoom Level Not Supported" tile).
5. **`public/wall.html` must link `wall-suite.css`** (was shipped unlinked in
   Phase 1, so the panel rendered flat white).
6. **Cloudflare overrode origin `no-cache` with `max-age=14400`.** A Cloudflare
   Cache Rule for `tally.thelopezfamily.org` (respect origin / bypass) fixed it;
   verified via `cf-cache-status: DYNAMIC`. The kiosk also self-reloads daily at 3 AM.

## Known issues / open polish

- Pi SSH blipped unreachable at end of session (Wi-Fi/lease); harmless, wall ran fine.
- `public/vendor/leaflet/` is dead weight now; can be deleted.
- `packagekitd` still enabled on the Pi (optional cleanup).

## What's next: the Bible verse slide

The user wants to add a **Bible verse panel** to the rotation next. Original design
lives in `docs/superpowers/specs/2026-06-01-tally-wall-suite-design.md` (the
"Verse/Fact" panel), but treat that as a starting point, not gospel; brainstorm it
fresh. Key starting points and decisions to settle:

- **Rotation wiring:** add a new panel key (e.g. `verse`) to `wall_enabled_panels`
  AND to the `KNOWN` set in `loadConfig()` in `wall.js` (currently only
  `chores`,`weather` are rendered). Add a `renderVerse()` and a rotation branch in
  `renderPanel()`. Pick a dwell (reuse `wall_other_dwell_sec` or a new key).
- **Keep it light** (text only) so the Pi stays smooth, this part is easy on the Pi.
- **Verses only vs verse/fact alternating?** User said "Bible verse slide", so likely
  verses only; confirm.
- **Translation / licensing:** the old spec said NABRE, which is copyrighted. Decide
  on a usable source (a public-domain translation like WEB/KJV, or a curated set with
  permission). Resolve before bundling `data/verses-*.json`.
- **Selection:** day-of-year index into a 365-entry list (one verse/day), or random.
- **Typography:** a clean, large, readable typographic slide that fits the wall's
  aesthetic and is legible across the room (and at night, like the weather text).

Suggested flow next session: `brainstorming` -> `writing-plans` ->
`subagent-driven-development`, then deploy + tag (e.g. `v0.13.0-verse`), then
`pkill chromium` on the Pi to refresh.
