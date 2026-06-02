# Weather Panel Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Tally wall weather panel as "Direction B" (hero + hourly curve + metrics strip) with a faded live-radar backdrop, and fix the missing stylesheet that made it render flat white.

**Architecture:** Expand the Open-Meteo client to return richer data (apparent temp, humidity, wind, hourly series, precip chance, condition text). The `/api/wall/weather` route surfaces the new fields plus a radar image URL. The single-file renderer `wall.js` rewrites `renderWeather()` to draw the new layout with a `mix-blend-mode: screen` radar backdrop. Link the existing `wall-suite.css` so the gradient themes and animations finally load, and extend it with the new layout styles.

**Tech Stack:** Node 20, Express 5, better-sqlite3, vanilla JS ES modules, `node --test`, supertest. Open-Meteo (no key) for forecast; NWS RIDGE loop GIF (no key) for radar.

**Radar source note:** The spec lists a transparent radar source as preferred, with the NWS RIDGE composite GIF as fallback. This plan ships the **NWS RIDGE loop GIF** (`https://radar.weather.gov/ridge/standard/<STATION>_loop.gif`, verified returning HTTP 200, animated, station configurable). That is exactly the source approved in the visual mockup with `mix-blend-mode: screen`. A transparent RainViewer tile source is an explicit follow-up, out of scope here.

> **As-built revision (2026-06-01):** Tasks 1-6 shipped as written. The radar piece was then reworked: the NWS GIF's gray base map went muddy under the blend and could not be centered on Hutto, so radar was rebuilt as a vendored **Leaflet** map (CARTO dark base + animated **RainViewer** frames + a pulsing Hutto dot + vignette-faded edges), and `wall_radar_station` was dropped (radar centers on `wall_weather_lat`/`lon`). See the revised "Radar backdrop" section of the spec for the shipped design. The Task 2/3 NWS-GIF and station details below are historical.

---

## File Structure

```
src/lib/wall/open-meteo.js       MODIFY  expand request; richer parseForecast; new wmoToText()
src/routes/wall.js               MODIFY  surface new fields; attach radar {enabled,url} to /wall/weather
src/migrations/013-weather-radar.sql  CREATE  seed wall_weather_radar, wall_radar_station
src/routes/admin/settings.js     MODIFY  whitelist + validate new keys
public/js/pages/admin.js         MODIFY  radar on/off + station fields in Wall Suite card
public/wall.html                 MODIFY  link wall-suite.css; link Noto Color Emoji font
public/css/wall-suite.css        MODIFY  hero/curve/metrics/radar-backdrop styles; emoji font-family
public/js/pages/wall.js          MODIFY  rewrite renderWeather()
tests/lib-wall-open-meteo.test.js     MODIFY  cover new fields + wmoToText
tests/routes-wall-weather.test.js     MODIFY  cover new fields + radar block
tests/routes-admin-settings-wall.test.js  MODIFY  cover new key validation
```

---

## Task 1: Expand Open-Meteo data layer

**Files:**
- Modify: `src/lib/wall/open-meteo.js`
- Test: `tests/lib-wall-open-meteo.test.js`

- [ ] **Step 1: Write failing tests for `wmoToText` and the richer `parseForecast`**

Append to `tests/lib-wall-open-meteo.test.js`:

```javascript
import { mapWmoToTheme, parseForecast, wmoToText } from '../src/lib/wall/open-meteo.js';

test('wmoToText is day/night aware for clear sky', () => {
  assert.equal(wmoToText(0, true),  'Sunny');
  assert.equal(wmoToText(0, false), 'Clear');
  assert.equal(wmoToText(2, true),  'Partly cloudy');
  assert.equal(wmoToText(3, true),  'Overcast');
  assert.equal(wmoToText(61, true), 'Rain');
  assert.equal(wmoToText(95, true), 'Thunderstorms');
  assert.equal(wmoToText(999, true), 'Cloudy'); // fallback
});

test('parseForecast extracts current extras, hourly slice, and precip', () => {
  const api = {
    current: {
      temperature_2m: 91.4, apparent_temperature: 97.2, relative_humidity_2m: 53,
      wind_speed_10m: 5.3, weather_code: 0, is_day: 1,
    },
    hourly: {
      time: Array.from({ length: 24 }, (_, i) => `2026-06-01T${String(i).padStart(2,'0')}:00`),
      temperature_2m: Array.from({ length: 24 }, (_, i) => 70 + i),
      weather_code: Array.from({ length: 24 }, () => 0),
      is_day: Array.from({ length: 24 }, (_, i) => (i >= 7 && i <= 20 ? 1 : 0)),
      precipitation_probability: Array.from({ length: 24 }, () => 10),
    },
    daily: {
      time: ['2026-06-01','2026-06-02','2026-06-03','2026-06-04'],
      weather_code: [0, 2, 3, 95],
      temperature_2m_max: [92, 92, 89, 88],
      temperature_2m_min: [73, 73, 70, 72],
      precipitation_probability_max: [0, 24, 24, 55],
      sunrise: ['2026-06-01T06:28','2026-06-02T06:28','2026-06-03T06:28','2026-06-04T06:28'],
      sunset:  ['2026-06-01T20:27','2026-06-02T20:27','2026-06-03T20:27','2026-06-04T20:27'],
    },
  };
  const f = parseForecast(api, { nowHourIndex: 18 });
  assert.equal(f.current_temp, 91);
  assert.equal(f.apparent_temp, 97);
  assert.equal(f.humidity, 53);
  assert.equal(f.wind, 5);
  assert.equal(f.condition, 'Sunny');
  assert.equal(f.today_precip, 0);
  assert.equal(f.sunrise, '2026-06-01T06:28');
  assert.equal(f.sunset, '2026-06-01T20:27');
  // hourly slice: 12 entries starting at index 18
  assert.equal(f.hourly.length, 12);
  assert.equal(f.hourly[0].temp, 88);          // 70 + 18
  assert.equal(f.hourly[0].precip_prob, 10);
  assert.equal(f.forecast[0].precip, 24);
  assert.equal(f.forecast[0].condition, 'Partly cloudy');
});

test('parseForecast tolerates missing hourly and short daily', () => {
  const f = parseForecast({ current: { temperature_2m: 80, weather_code: 0, is_day: 1 }, daily: {} });
  assert.equal(f.current_temp, 80);
  assert.deepEqual(f.hourly, []);
  assert.deepEqual(f.forecast, []);
  assert.equal(f.apparent_temp, 80); // falls back to current_temp when absent
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/projects/tally && node --test tests/lib-wall-open-meteo.test.js`
Expected: FAIL (`wmoToText` is not exported; new fields undefined).

- [ ] **Step 3: Implement the expanded client**

Replace the body of `src/lib/wall/open-meteo.js` from `parseForecast` onward, and add `wmoToText`. Keep `THEME_BY_CODE` and `mapWmoToTheme` as-is. Add above `parseForecast`:

```javascript
const TEXT_BY_CODE = new Map([
  [0, 'Clear'], [1, 'Clear'], [2, 'Partly cloudy'], [3, 'Overcast'],
  [45, 'Fog'], [48, 'Fog'],
  [51, 'Drizzle'], [53, 'Drizzle'], [55, 'Drizzle'], [56, 'Freezing drizzle'], [57, 'Freezing drizzle'],
  [61, 'Rain'], [63, 'Rain'], [65, 'Heavy rain'], [66, 'Freezing rain'], [67, 'Freezing rain'],
  [71, 'Snow'], [73, 'Snow'], [75, 'Heavy snow'], [77, 'Snow grains'],
  [80, 'Rain showers'], [81, 'Rain showers'], [82, 'Heavy showers'],
  [85, 'Snow showers'], [86, 'Snow showers'],
  [95, 'Thunderstorms'], [96, 'Thunderstorms'], [99, 'Thunderstorms'],
]);

export function wmoToText(code, isDay) {
  if ((code === 0 || code === 1) && isDay) return 'Sunny';
  return TEXT_BY_CODE.get(code) || 'Cloudy';
}
```

Replace `parseForecast` with:

```javascript
export function parseForecast(json, opts = {}) {
  const cur = json.current || {};
  const d = json.daily || {};
  const h = json.hourly || {};
  const curTemp = Math.round(cur.temperature_2m ?? 0);
  const isDay = !!cur.is_day;

  const todayHigh = Math.round(d.temperature_2m_max?.[0] ?? 0);
  const todayLow  = Math.round(d.temperature_2m_min?.[0] ?? 0);

  const forecast = [];
  for (let i = 1; i <= 3 && i < (d.time?.length || 0); i++) {
    const code = d.weather_code?.[i] ?? -1;
    forecast.push({
      day_iso:   d.time[i],
      theme:     mapWmoToTheme(code, true),
      code,
      condition: wmoToText(code, true),
      high:      Math.round(d.temperature_2m_max?.[i] ?? 0),
      low:       Math.round(d.temperature_2m_min?.[i] ?? 0),
      precip:    Math.round(d.precipitation_probability_max?.[i] ?? 0),
    });
  }

  // Hourly: next 12 entries from the current hour. nowHourIndex injectable for tests.
  const hourly = [];
  const times = h.time || [];
  let start = opts.nowHourIndex;
  if (start == null) {
    const nowIso = (new Date()).toISOString().slice(0, 13); // YYYY-MM-DDTHH
    start = times.findIndex(t => String(t).slice(0, 13) >= nowIso);
    if (start < 0) start = 0;
  }
  for (let i = start; i < start + 12 && i < times.length; i++) {
    hourly.push({
      time:        times[i],
      temp:        Math.round(h.temperature_2m?.[i] ?? 0),
      code:        h.weather_code?.[i] ?? -1,
      is_day:      !!h.is_day?.[i],
      precip_prob: Math.round(h.precipitation_probability?.[i] ?? 0),
    });
  }

  return {
    current_temp: curTemp,
    apparent_temp: Math.round(cur.apparent_temperature ?? cur.temperature_2m ?? 0),
    humidity:     Math.round(cur.relative_humidity_2m ?? 0),
    wind:         Math.round(cur.wind_speed_10m ?? 0),
    condition:    wmoToText(cur.weather_code ?? -1, isDay),
    theme:        mapWmoToTheme(cur.weather_code ?? -1, isDay),
    is_day:       isDay,
    today_high:   todayHigh,
    today_low:    todayLow,
    today_precip: Math.round(d.precipitation_probability_max?.[0] ?? 0),
    sunrise:      d.sunrise?.[0] ?? null,
    sunset:       d.sunset?.[0] ?? null,
    hourly,
    forecast,
  };
}
```

Update `fetchOpenMeteo` query params:

```javascript
  url.searchParams.set('current',  'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day');
  url.searchParams.set('hourly',   'temperature_2m,weather_code,is_day,precipitation_probability');
  url.searchParams.set('daily',    'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset');
  url.searchParams.set('temperature_unit', tempUnit);
  url.searchParams.set('wind_speed_unit', unit === 'C' ? 'kmh' : 'mph');
  url.searchParams.set('timezone',  'auto');
  url.searchParams.set('forecast_days', '4');
```

(Add the `wind_speed_unit` and `forecast_days` lines; keep the existing `latitude`/`longitude` lines.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/projects/tally && node --test tests/lib-wall-open-meteo.test.js`
Expected: PASS (all, including the original 8).

- [ ] **Step 5: Commit**

```bash
git add src/lib/wall/open-meteo.js tests/lib-wall-open-meteo.test.js
git commit -m "feat(wall): expand open-meteo data (hourly, humidity, wind, precip, condition text)"
```

---

## Task 2: Surface new fields + radar on the weather route

**Files:**
- Modify: `src/routes/wall.js:60-94` (the `/wall/weather` handler)
- Test: `tests/routes-wall-weather.test.js`

- [ ] **Step 1: Write failing tests**

In `tests/routes-wall-weather.test.js`, extend `SAMPLE_API` to include the new fields, then add assertions. Replace `SAMPLE_API` with:

```javascript
const SAMPLE_API = {
  current: { temperature_2m: 73.1, apparent_temperature: 75.0, relative_humidity_2m: 50,
             wind_speed_10m: 6, weather_code: 0, is_day: 1 },
  hourly: {
    time: Array.from({ length: 24 }, (_, i) => `2026-06-01T${String(i).padStart(2,'0')}:00`),
    temperature_2m: Array.from({ length: 24 }, (_, i) => 70 + i),
    weather_code: Array.from({ length: 24 }, () => 0),
    is_day: Array.from({ length: 24 }, () => 1),
    precipitation_probability: Array.from({ length: 24 }, () => 5),
  },
  daily: {
    time: ['2026-06-01','2026-06-02','2026-06-03','2026-06-04'],
    weather_code: [0, 2, 61, 0],
    temperature_2m_max: [85, 80, 75, 88],
    temperature_2m_min: [62, 60, 58, 65],
    precipitation_probability_max: [0, 24, 55, 0],
    sunrise: ['2026-06-01T06:00','2026-06-02T06:00','2026-06-03T06:00','2026-06-04T06:00'],
    sunset:  ['2026-06-01T20:30','2026-06-02T20:30','2026-06-03T20:30','2026-06-04T20:30'],
  },
};
```

Add two tests:

```javascript
test('GET /api/wall/weather surfaces extras and a radar block when enabled', async () => {
  _resetWeatherState();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => SAMPLE_API });
  try {
    const db = freshDb();
    db.prepare("UPDATE settings SET value=? WHERE key='wall_weather_lat'").run('30.5');
    db.prepare("UPDATE settings SET value=? WHERE key='wall_weather_lon'").run('-97.6');
    const app = freshApp(db);
    const r = await request(app).get('/api/wall/weather');
    assert.equal(r.body.apparent_temp, 75);
    assert.equal(r.body.humidity, 50);
    assert.equal(r.body.condition, 'Sunny');
    assert.ok(Array.isArray(r.body.hourly));
    assert.equal(r.body.radar.enabled, true);
    assert.match(r.body.radar.url, /KEWX_loop\.gif/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GET /api/wall/weather radar disabled yields radar.enabled false', async () => {
  _resetWeatherState();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => SAMPLE_API });
  try {
    const db = freshDb();
    db.prepare("UPDATE settings SET value=? WHERE key='wall_weather_lat'").run('30.5');
    db.prepare("UPDATE settings SET value=? WHERE key='wall_weather_lon'").run('-97.6');
    db.prepare("INSERT INTO settings(key,value) VALUES('wall_weather_radar','off') ON CONFLICT(key) DO UPDATE SET value='off'").run();
    const app = freshApp(db);
    const r = await request(app).get('/api/wall/weather');
    assert.equal(r.body.radar.enabled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/projects/tally && node --test tests/routes-wall-weather.test.js`
Expected: FAIL (`r.body.radar` is undefined).

- [ ] **Step 3: Implement radar attachment**

The new fields flow through automatically because `parseForecast` now returns them and the route already spreads `...parsed`. Add the radar block. In `src/routes/wall.js`, define a helper near the top (after the constants):

```javascript
function radarBlock(db) {
  const rows = db.prepare(
    "SELECT key, value FROM settings WHERE key IN ('wall_weather_radar','wall_radar_station')"
  ).all();
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const enabled = (s.wall_weather_radar ?? 'on') !== 'off';
  const station = (s.wall_radar_station || 'KEWX').toUpperCase();
  if (!enabled) return { enabled: false, url: null };
  return {
    enabled: true,
    // cache-bust so the wall pulls fresh radar frames each visit
    url: `https://radar.weather.gov/ridge/standard/${station}_loop.gif?cb=${Date.now()}`,
  };
}
```

Then in the `/wall/weather` handler, attach `radar` to every non-skip return. Change the three `res.json({ ...parsed, unit ... })` style returns to include `radar: radarBlock(db)`:

```javascript
    // cache hit
    if (weatherCache && weatherCache.key === cacheKey && (now - weatherCache.fetchedAt) < WEATHER_CACHE_MS) {
      return res.json({ ...weatherCache.data, unit, radar: radarBlock(db) });
    }
    // ...
      return res.json({ ...parsed, unit, radar: radarBlock(db) });
    // ...
        return res.json({ ...weatherCache.data, unit, stale: true, radar: radarBlock(db) });
```

(The `skip` returns stay unchanged: radar is only attached when weather renders.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/projects/tally && node --test tests/routes-wall-weather.test.js`
Expected: PASS (original 3 + new 2).

- [ ] **Step 5: Commit**

```bash
git add src/routes/wall.js tests/routes-wall-weather.test.js
git commit -m "feat(wall): surface weather extras and radar URL on /api/wall/weather"
```

---

## Task 3: Settings — migration, validation, admin UI

**Files:**
- Create: `src/migrations/013-weather-radar.sql`
- Modify: `src/routes/admin/settings.js` (EDITABLE_KEYS + validation)
- Modify: `public/js/pages/admin.js` (Wall Suite card fields)
- Test: `tests/routes-admin-settings-wall.test.js`

- [ ] **Step 1: Create the migration**

Create `src/migrations/013-weather-radar.sql`:

```sql
INSERT INTO settings (key, value) VALUES
  ('wall_weather_radar', 'on'),
  ('wall_radar_station', 'KEWX')
ON CONFLICT(key) DO NOTHING;
```

- [ ] **Step 2: Write failing validation tests**

Add to `tests/routes-admin-settings-wall.test.js` (follow the file's existing style for issuing PATCH requests; mirror an existing passing case):

```javascript
test('PATCH wall_weather_radar accepts on/off and rejects junk', async () => {
  const db = freshDb();
  const app = freshApp(db);
  assert.equal((await request(app).patch('/api/admin/settings/wall_weather_radar').send({ value: 'off' })).status, 200);
  assert.equal((await request(app).patch('/api/admin/settings/wall_weather_radar').send({ value: 'on' })).status, 200);
  assert.equal((await request(app).patch('/api/admin/settings/wall_weather_radar').send({ value: 'maybe' })).status, 400);
});

test('PATCH wall_radar_station accepts a 3-4 letter id and rejects junk', async () => {
  const db = freshDb();
  const app = freshApp(db);
  assert.equal((await request(app).patch('/api/admin/settings/wall_radar_station').send({ value: 'KGRK' })).status, 200);
  assert.equal((await request(app).patch('/api/admin/settings/wall_radar_station').send({ value: '12' })).status, 400);
});
```

(If the test file does not already authenticate admin requests, copy the auth/setup preamble from the existing tests in that same file.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd ~/projects/tally && node --test tests/routes-admin-settings-wall.test.js`
Expected: FAIL (keys not whitelisted -> 400 on the valid cases).

- [ ] **Step 4: Whitelist and validate the keys**

In `src/routes/admin/settings.js`, add to the `EDITABLE_KEYS` set (after `'wall_sleep_clock_style'`):

```javascript
  'wall_weather_radar',
  'wall_radar_station',
```

Add validation rules alongside the existing `if (key === ...)` blocks:

```javascript
    if (key === 'wall_weather_radar' && value !== 'on' && value !== 'off') {
      return res.status(400).json({ error: 'wall_weather_radar must be on or off' });
    }
    if (key === 'wall_radar_station' && !/^[A-Za-z]{3,4}$/.test(value)) {
      return res.status(400).json({ error: 'wall_radar_station must be a 3-4 letter NWS station id' });
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ~/projects/tally && node --test tests/routes-admin-settings-wall.test.js`
Expected: PASS.

- [ ] **Step 6: Add the admin UI fields**

In `public/js/pages/admin.js`, after the weather test button block (around line 757, before the `// Sleep window` comment), add a radar toggle and station field:

```javascript
  // Radar backdrop
  const radarToggle = el('div', { class: 'form-field' }, [
    el('label', {}, ['Weather radar backdrop']),
    el('select', {
      onChange: async (e) => {
        try { await api.patch('/api/admin/settings/wall_weather_radar', { value: e.target.value }); }
        catch (err) { alert('Save failed: ' + err.message); }
      },
    }, [['on','On'], ['off','Off']].map(([v, label]) =>
        el('option', { value: v, selected: (s.wall_weather_radar || 'on') === v }, [label]))),
    el('div', { class: 'muted', style: { fontSize: '0.78rem', marginTop: '4px' } },
      ['Shows live precipitation radar faded behind the weather panel.']),
  ]);
  host.appendChild(radarToggle);

  host.appendChild((() => {
    const field = el('div', { class: 'form-field' }, [
      el('label', {}, ['Radar station (NWS)']),
      el('input', {
        type: 'text', value: s.wall_radar_station || 'KEWX', maxLength: 4,
        onChange: async (e) => {
          try {
            await api.patch('/api/admin/settings/wall_radar_station', { value: e.target.value.toUpperCase() });
            e.target.value = e.target.value.toUpperCase();
            e.target.style.borderColor = 'var(--green)';
            setTimeout(() => { e.target.style.borderColor = ''; }, 800);
          } catch (err) { alert('Save failed: ' + err.message); }
        },
      }),
      el('div', { class: 'muted', style: { fontSize: '0.78rem', marginTop: '4px' } },
        ['NWS RIDGE station id. KEWX covers Central Texas (Hutto).']),
    ]);
    return field;
  })());
```

- [ ] **Step 7: Commit**

```bash
git add src/migrations/013-weather-radar.sql src/routes/admin/settings.js public/js/pages/admin.js tests/routes-admin-settings-wall.test.js
git commit -m "feat(wall): radar settings (toggle + station) with validation and admin UI"
```

---

## Task 4: Wire the stylesheet and color emoji font

**Files:**
- Modify: `public/wall.html:10-13`

- [ ] **Step 1: Add the two links**

In `public/wall.html`, after the `layouts.css` link (line 13), add:

```html
  <link rel="stylesheet" href="/css/wall-suite.css" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Color+Emoji&display=swap" />
```

`wall-suite.css` must come after `layouts.css` so `.weather-theme-*` backgrounds win over `.wall-page { background: var(--bg) }`. The Noto Color Emoji webfont guarantees colored emoji regardless of the Pi's installed fonts (the wall already requires internet for weather/radar, so a CDN font load is consistent).

- [ ] **Step 2: Verify the page still loads**

Run: `cd ~/projects/tally && pm2 restart tally --update-env && pm2 logs tally --lines 8 --nostream`
Expected: no startup errors. (Visual confirmation happens in Task 7.)

- [ ] **Step 3: Commit**

```bash
git add public/wall.html
git commit -m "fix(wall): link wall-suite.css (was never loaded) and color emoji font"
```

---

## Task 5: Weather panel styles

**Files:**
- Modify: `public/css/wall-suite.css`

- [ ] **Step 1: Replace the weather layout styles**

In `public/css/wall-suite.css`, replace the existing `.weather-body`, `.weather-current`, and `.weather-forecast` blocks (lines ~8-14 and ~38-46) with the Direction B layout. Keep all the `.weather-theme-*` gradient and animation rules untouched. Add:

```css
/* Direction B weather layout. The panel root keeps class
   `wall-page wall-page-weather weather-theme-<theme>`. */
.wall-page-weather { position: relative; overflow: hidden; }

/* Radar backdrop: fills the body, sits behind content, blended into the gradient. */
.weather-radar {
  position: absolute; left: 0; right: 0; top: 64px; bottom: 0; z-index: 0;
  background-size: cover; background-position: center;
  opacity: 0.55; mix-blend-mode: screen; pointer-events: none;
  -webkit-mask-image: linear-gradient(to bottom, transparent 0%, #000 22%, #000 100%);
  mask-image: linear-gradient(to bottom, transparent 0%, #000 22%, #000 100%);
}
.weather-radar-tag {
  position: absolute; right: 16px; top: 72px; z-index: 2;
  font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em;
  opacity: 0.7; background: rgba(0,0,0,0.25); padding: 3px 9px; border-radius: 20px;
}

/* Content layer sits above the radar. */
.weather-layer { position: relative; z-index: 1; flex: 1; display: flex; flex-direction: column; }

.weather-ico, .weather-forecast .ico {
  font-family: 'Noto Color Emoji', 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif;
}

/* Hero row */
.weather-hero { display: flex; align-items: center; gap: 26px; padding: 4px 4px 0; }
.weather-hero .weather-ico { font-size: 6vh; filter: drop-shadow(0 2px 4px rgba(0,0,0,.22)); }
.weather-hero .temp { font-size: 11vh; font-weight: 300; line-height: 0.9; text-shadow: 0 2px 10px rgba(0,0,0,.16); }
.weather-hero .cond { font-size: 3vh; font-weight: 600; }
.weather-hero .sub  { font-size: 2vh; opacity: 0.92; }
.weather-hero .hero-fc { margin-left: auto; display: flex; gap: 2.2vw; }
.weather-hero .hero-fc .day { text-align: center; }
.weather-hero .hero-fc .label { font-size: 1.4vh; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.85; }
.weather-hero .hero-fc .ico { font-size: 3vh; margin: 0.4vh 0; }
.weather-hero .hero-fc .hilo { font-size: 1.9vh; font-weight: 600; font-variant-numeric: tabular-nums; }
.weather-hero .hero-fc .pop  { font-size: 1.3vh; opacity: 0.8; }

/* Hourly curve */
.weather-curve { height: 8vh; padding: 1vh 1vw 0; }
.weather-curve svg { width: 100%; height: 100%; overflow: visible; }
.weather-curve polyline { fill: none; stroke: rgba(255,255,255,0.95); stroke-width: 1.5; }
.weather-curve .marker { fill: #fff; }
.weather-hours { display: flex; justify-content: space-between; padding: 0.4vh 1vw 0;
  font-size: 1.3vh; opacity: 0.9; text-shadow: 0 1px 3px rgba(0,0,0,.3); }

/* Metrics strip */
.weather-metrics { margin-top: auto; display: flex; z-index: 1; position: relative;
  background: rgba(0,0,0,0.18); border-top: 1px solid rgba(255,255,255,0.22); }
.weather-metrics .m { flex: 1; text-align: center; padding: 1.2vh 4px;
  border-right: 1px solid rgba(255,255,255,0.16); }
.weather-metrics .m:last-child { border-right: 0; }
.weather-metrics .m .k { font-size: 1.2vh; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.85; }
.weather-metrics .m .v { font-size: 2.4vh; font-weight: 600; }

/* Snow theme keeps dark text for legibility (existing rule sets color #0F172A). */
.weather-theme-snow .weather-curve polyline { stroke: rgba(15,23,42,0.9); }
.weather-theme-snow .weather-metrics { background: rgba(255,255,255,0.35); }
```

- [ ] **Step 2: Commit**

```bash
git add public/css/wall-suite.css
git commit -m "feat(wall): Direction B weather styles (hero, hourly curve, metrics, radar backdrop)"
```

---

## Task 6: Rewrite the weather renderer

**Files:**
- Modify: `public/js/pages/wall.js` (the `WEATHER_ICONS` map at lines 15-24 and `renderWeather()` at lines 231-270)

- [ ] **Step 1: Add emoji variation selectors to the icon map**

Replace the `WEATHER_ICONS` map (lines 15-24) so each glyph requests emoji presentation:

```javascript
const WEATHER_ICONS = {
  'clear-day':     '☀️',   // sun
  'clear-night':   '🌙',   // crescent moon
  'partly-cloudy': '⛅',          // sun behind cloud
  'overcast':      '☁️',   // cloud
  'fog':           '🌫️',
  'rain':          '🌧️',
  'snow':          '❄️',
  'thunderstorm':  '⛈️',
};
```

- [ ] **Step 2: Rewrite `renderWeather()`**

Replace `renderWeather()` (lines 231-270) with:

```javascript
async function renderWeather() {
  const data = await api.get('/api/wall/weather').catch(() => null);
  if (!data || data.skip) { await renderChores(); return; }

  clear(root);
  const now = new Date();
  const u = data.unit === 'C' ? '°C' : '°F';
  const theme = data.theme || 'clear-day';
  const dayName = iso => DAYS[new Date(iso + 'T00:00:00').getDay()].slice(0, 3);
  const hhmm = iso => {
    if (!iso) return '';
    const d = new Date(iso);
    let h = d.getHours(); const m = String(d.getMinutes()).padStart(2, '0');
    const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    return `${h}:${m} ${ap}`;
  };

  // Forecast strip
  const heroFc = (data.forecast || []).slice(0, 3).map(day =>
    el('div', { class: 'day' }, [
      el('div', { class: 'label' }, [dayName(day.day_iso)]),
      el('div', { class: 'ico' }, [WEATHER_ICONS[day.theme] || '·']),
      el('div', { class: 'hilo' }, [`${day.high}°/${day.low}°`]),
      el('div', { class: 'pop' }, [`${day.precip}%`]),
    ])
  );

  // Hourly curve: map temps to an SVG polyline (viewBox 100 x 28).
  const hrs = (data.hourly || []).slice(0, 12);
  let curveEls = [];
  if (hrs.length >= 2) {
    const temps = hrs.map(h => h.temp);
    const min = Math.min(...temps), max = Math.max(...temps);
    const span = (max - min) || 1;
    const pts = hrs.map((h, i) => {
      const x = (i / (hrs.length - 1)) * 100;
      const y = 24 - ((h.temp - min) / span) * 20; // 4..24 inverted
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 28');
    svg.setAttribute('preserveAspectRatio', 'none');
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('points', pts);
    svg.appendChild(poly);
    curveEls = [el('div', { class: 'weather-curve' }, [svg])];

    // Sparse hour labels: now, +3, +6, +9, +11 plus sunset/sunrise marker.
    const fmtH = d => { let h = new Date(d.time).getHours(); const ap = h >= 12 ? 'p' : 'a'; h = h % 12 || 12; return `${h}${ap}`; };
    const idxs = [0, 3, 6, 9, hrs.length - 1].filter((v, i, a) => v < hrs.length && a.indexOf(v) === i);
    const labels = idxs.map(i =>
      el('span', {}, [i === 0 ? `Now ${hrs[0].temp}°` : `${fmtH(hrs[i])} ${hrs[i].temp}°`]));
    const sun = data.is_day ? `🌙 ${hhmm(data.sunset)}` : `☀️ ${hhmm(data.sunrise)}`;
    labels.splice(Math.ceil(labels.length / 2), 0, el('span', {}, [sun]));
    curveEls.push(el('div', { class: 'weather-hours' }, labels));
  }

  // Metrics strip
  const nextSun = data.is_day
    ? ['Sunset', hhmm(data.sunset)]
    : ['Sunrise', hhmm(data.sunrise)];
  const metrics = el('div', { class: 'weather-metrics' }, [
    ['Humidity', `${data.humidity}%`],
    ['Wind', `${data.wind} ${data.unit === 'C' ? 'km/h' : 'mph'}`],
    ['Rain chance', `${data.today_precip}%`],
    nextSun,
  ].map(([k, v]) => el('div', { class: 'm' }, [
    el('div', { class: 'k' }, [k]), el('div', { class: 'v' }, [v]),
  ])));

  // Radar backdrop (decorative; only when enabled and a url is present)
  const radarEls = [];
  if (data.radar && data.radar.enabled && data.radar.url) {
    const bg = el('div', { class: 'weather-radar' }, []);
    bg.style.backgroundImage = `url('${data.radar.url}')`;
    radarEls.push(bg, el('div', { class: 'weather-radar-tag' }, ['◗ Live radar']));
  }

  root.appendChild(el('div', { class: `wall-page wall-page-weather weather-theme-${theme}` }, [
    ...radarEls,
    el('div', { class: 'weather-layer' }, [
      el('div', { class: 'wall-header' }, [
        el('h2', {}, [`The Lopez House · ${fmtDate(now)}`]),
        el('span', { class: 't' }, [fmtTime(now)]),
      ]),
      el('div', { class: 'weather-hero' }, [
        el('div', { class: 'weather-ico' }, [WEATHER_ICONS[theme] || '·']),
        el('div', { class: 'temp' }, [`${data.current_temp}${u}`]),
        el('div', {}, [
          el('div', { class: 'cond' }, [data.condition || '']),
          el('div', { class: 'sub' }, [`Feels ${data.apparent_temp}${u} · H ${data.today_high}° L ${data.today_low}°`]),
        ]),
        el('div', { class: 'hero-fc' }, heroFc),
      ]),
      ...curveEls,
      metrics,
    ]),
  ]));
}
```

- [ ] **Step 3: Verify the existing wall render test still passes**

Run: `cd ~/projects/tally && node --test tests/routes-wall.test.js tests/lib-wall-rotation.test.js`
Expected: PASS (these do not assert on weather DOM; confirm no import/syntax breakage).

- [ ] **Step 4: Run the full suite**

Run: `cd ~/projects/tally && npm test`
Expected: PASS (all tests, ~265 + the new ones).

- [ ] **Step 5: Commit**

```bash
git add public/js/pages/wall.js
git commit -m "feat(wall): render Direction B weather panel with hourly curve and radar backdrop"
```

---

## Task 7: Manual browser verification (the Phase 1 lesson)

**Files:** none (verification only)

- [ ] **Step 1: Restart and set Hutto location + radar**

```bash
cd ~/projects/tally && pm2 restart tally --update-env
curl -s https://tally.thelopezfamily.org/api/wall/weather | jq '{current_temp, condition, humidity, wind, hourly: (.hourly|length), radar}'
```
Expected: non-skip JSON with `condition`, `humidity`, `wind`, `hourly` length 12, and `radar.enabled: true` with a `KEWX_loop.gif` url.

- [ ] **Step 2: Load the wall in a real browser**

Open `https://tally.thelopezfamily.org/wall` and wait for the weather panel in rotation. Confirm:
- Background shows the theme gradient (not flat white).
- The condition emoji renders in color (not a monochrome glyph).
- Hero temp, condition word, feels-like, and 3-day strip render.
- The hourly curve draws and hour labels show with a sunset/sunrise marker.
- The metrics strip is legible.
- The radar backdrop appears faded behind the content (faint when clear).

- [ ] **Step 3: Force a stormy theme to confirm radar echoes glow**

Temporarily point at a location with active precipitation to confirm the `screen` blend shows echoes, then restore Hutto:

```bash
node -e "import('better-sqlite3').then(({default:D})=>{const d=new D('./tally.db');d.prepare(\"UPDATE settings SET value=? WHERE key=?\").run('30.5083','wall_weather_lat');d.prepare(\"UPDATE settings SET value=? WHERE key=?\").run('-97.5469','wall_weather_lon');})"
```

- [ ] **Step 4: Confirm graceful degradation**

In admin Settings, set the radar backdrop to Off, reload the wall, confirm the weather panel renders normally on its gradient with no backdrop. Turn it back On.

- [ ] **Step 5: Tag the release**

```bash
cd ~/projects/tally && git tag -a v0.12.1-weather-panel -m "Weather panel redesign: Direction B + radar backdrop"
```

---

## Self-Review Notes

- **Spec coverage:** missing-stylesheet fix (Task 4), Direction B layout (Tasks 5-6), expanded data + condition text (Task 1), radar backdrop with NWS source + graceful skip (Tasks 2, 6, 7), emoji color font (Tasks 4-6), settings keys + validation + UI (Task 3), tests + manual browser check (all tasks + Task 7). The spec's "prefer transparent radar source" is intentionally deferred; see the Radar source note in the header.
- **Type consistency:** `parseForecast` returns `{current_temp, apparent_temp, humidity, wind, condition, theme, is_day, today_high, today_low, today_precip, sunrise, sunset, hourly[], forecast[]}`; the route spreads these and adds `unit` + `radar{enabled,url}`; the renderer reads exactly those names. Forecast entries use `{day_iso, theme, code, condition, high, low, precip}`; hourly entries use `{time, temp, code, is_day, precip_prob}`. Consistent across tasks.
```
