# Wall Suite Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the scaffold for a multi-panel rotating wall (`/wall`) on Tally with the chores panel ported behind a panel interface, a working Weather panel (Open-Meteo + 8 CSS themes), a configurable overnight sleep mode with a drifting dim clock (digital/analog-minimal/analog-classic), a persistent header, and admin Settings to configure all of it.

**Architecture:** The existing `/wall` page becomes a stage that hosts panels. Each panel exports `{ key, fetch, mount, unmount, refresh? }`. The stage runs a chores-heavy smart cycle (chores 60s → other 15s → chores ...) with `skip:true` honored from `fetch()`. A `/api/wall/config` endpoint exposes the public subset of settings to the wall page. Sleep mode paints black, hides header, stops timers, and mounts a sleep clock that drifts every 60s to defeat burn-in.

**Tech Stack:** Node 20 ESM, Express 5, better-sqlite3, vanilla JS (ES modules), CSS custom properties, Open-Meteo HTTPS API, SSE.

**Spec:** `docs/superpowers/specs/2026-06-01-tally-wall-suite-design.md`

---

## File map

**New:**
```
src/migrations/012-wall-suite.sql        new settings keys with defaults
src/lib/wall/open-meteo.js               Open-Meteo client + WMO -> theme mapping (server)
public/js/wall/rotation.js               smart-cycle cursor walker (shared: browser + tests)
public/js/wall/sleep.js                  sleep-window calculation (shared: browser + tests)
public/js/wall/stage.js                  rotation orchestrator + panel lifecycle
public/js/wall/header.js                 persistent header (clock/date/streak leader)
public/js/wall/sleep-clock.js            drifting dim clock (3 styles)
public/js/wall/panels/chores.js          chores panel module (wraps existing logic)
public/js/wall/panels/weather.js         weather panel module + theme application
public/css/wall-suite.css                stage layout, panel themes, animations
tests/lib-wall-open-meteo.test.js
tests/lib-wall-rotation.test.js
tests/lib-wall-sleep.test.js
tests/routes-wall-config.test.js
tests/routes-wall-weather.test.js
tests/routes-admin-settings-wall.test.js (new validators only)
```

**Note:** `rotation.js` and `sleep.js` live in `public/js/wall/` rather than `src/lib/wall/` because the browser stage imports them at runtime. They are pure ESM with no Node dependencies, so the Node test runner imports them directly from the same path.

**Modified:**
```
src/routes/wall.js                       add weather + config endpoints inline
src/routes/admin/settings.js             add EDITABLE_KEYS + validators
public/wall.html                         load wall-suite.css, point bootstrap at stage.js
public/js/pages/wall.js                  thin bootstrap that wires the stage
public/js/pages/admin.js                 Settings UI Wall Suite card group
```

**Note on file organization:** spec suggested a `src/routes/wall/` subdirectory; for Phase 1 we keep all wall server routes in the existing `src/routes/wall.js` to minimize churn. If the file grows over ~250 lines after Phase 2, we revisit.

---

## Task 1: Migration 012 + settings whitelist + validators

**Files:**
- Create: `src/migrations/012-wall-suite.sql`
- Modify: `src/routes/admin/settings.js`
- Test: `tests/routes-admin-settings-wall.test.js`

- [ ] **Step 1: Write the migration**

Create `src/migrations/012-wall-suite.sql`:

```sql
INSERT INTO settings (key, value) VALUES
  ('wall_enabled_panels',     'chores,weather,calendar,verse-fact'),
  ('wall_chores_dwell_sec',   '60'),
  ('wall_other_dwell_sec',    '15'),
  ('wall_weather_lat',        ''),
  ('wall_weather_lon',        ''),
  ('wall_weather_unit',       'F'),
  ('wall_sleep_start',        '22:00'),
  ('wall_sleep_end',          '06:00'),
  ('wall_sleep_clock_style',  'analog-minimal')
ON CONFLICT(key) DO NOTHING;
```

- [ ] **Step 2: Verify migration applies on a fresh DB**

Run: `cd ~/projects/tally && node -e "import('./src/db.js').then(async ({runMigrations}) => { const D=(await import('better-sqlite3')).default; const db=new D(':memory:'); runMigrations(db); console.log(db.prepare(\"SELECT key,value FROM settings WHERE key LIKE 'wall_%' ORDER BY key\").all()); })"`

Expected: 9 rows listed, including `wall_chores_dwell_sec = 60`.

- [ ] **Step 3: Add validator helpers and whitelist entries**

In `src/routes/admin/settings.js`, after the existing `DAY_NAMES` declaration, add:

```js
const WALL_PANEL_KEYS = new Set(['chores', 'weather', 'calendar', 'verse-fact']);
const WALL_CLOCK_STYLES = new Set(['digital', 'analog-minimal', 'analog-classic']);

function isHHMM(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}
function isIntInRange(s, lo, hi) {
  if (typeof s !== 'string') return false;
  const n = Number(s);
  return Number.isInteger(n) && n >= lo && n <= hi;
}
function isNumOrEmpty(s, lo, hi) {
  if (typeof s !== 'string') return false;
  if (s === '') return true;
  const n = Number(s);
  return Number.isFinite(n) && n >= lo && n <= hi;
}
function isValidEnabledPanels(s) {
  if (typeof s !== 'string') return false;
  const parts = s.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  if (!parts.includes('chores')) return false;
  return parts.every(p => WALL_PANEL_KEYS.has(p));
}
```

Add these keys to `EDITABLE_KEYS` (the existing `new Set([...])`):
```
'wall_enabled_panels',
'wall_chores_dwell_sec',
'wall_other_dwell_sec',
'wall_weather_lat',
'wall_weather_lon',
'wall_weather_unit',
'wall_sleep_start',
'wall_sleep_end',
'wall_sleep_clock_style',
```

In the PATCH handler, after the existing `payout_day` check and before the INSERT, add:

```js
    if (key === 'wall_enabled_panels' && !isValidEnabledPanels(value)) {
      return res.status(400).json({ error: 'wall_enabled_panels must be a comma list containing "chores"' });
    }
    if ((key === 'wall_chores_dwell_sec' || key === 'wall_other_dwell_sec') && !isIntInRange(value, 5, 600)) {
      return res.status(400).json({ error: `${key} must be an integer 5..600` });
    }
    if (key === 'wall_weather_lat' && !isNumOrEmpty(value, -90, 90)) {
      return res.status(400).json({ error: 'wall_weather_lat must be a number -90..90 or empty' });
    }
    if (key === 'wall_weather_lon' && !isNumOrEmpty(value, -180, 180)) {
      return res.status(400).json({ error: 'wall_weather_lon must be a number -180..180 or empty' });
    }
    if (key === 'wall_weather_unit' && value !== 'F' && value !== 'C') {
      return res.status(400).json({ error: 'wall_weather_unit must be F or C' });
    }
    if ((key === 'wall_sleep_start' || key === 'wall_sleep_end') && !isHHMM(value)) {
      return res.status(400).json({ error: `${key} must be HH:MM 00:00..23:59` });
    }
    if (key === 'wall_sleep_clock_style' && !WALL_CLOCK_STYLES.has(value)) {
      return res.status(400).json({ error: 'wall_sleep_clock_style must be digital, analog-minimal, or analog-classic' });
    }
```

- [ ] **Step 4: Write failing tests for validators**

Create `tests/routes-admin-settings-wall.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';

async function asParent(app, db) {
  const id = db.prepare("INSERT INTO people (name, role) VALUES ('Mom','parent') RETURNING id").get().id;
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id, pin: '1234' });
  return agent;
}

test('PATCH wall_enabled_panels accepts a valid list', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const r = await agent.patch('/api/admin/settings/wall_enabled_panels').send({ value: 'chores,weather' });
  assert.equal(r.status, 200);
});

test('PATCH wall_enabled_panels rejects a list missing chores', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const r = await agent.patch('/api/admin/settings/wall_enabled_panels').send({ value: 'weather,calendar' });
  assert.equal(r.status, 400);
});

test('PATCH wall_enabled_panels rejects an unknown panel key', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const r = await agent.patch('/api/admin/settings/wall_enabled_panels').send({ value: 'chores,sports' });
  assert.equal(r.status, 400);
});

test('PATCH wall_chores_dwell_sec accepts 60', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const r = await agent.patch('/api/admin/settings/wall_chores_dwell_sec').send({ value: '60' });
  assert.equal(r.status, 200);
});

test('PATCH wall_chores_dwell_sec rejects 4 and 601', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const a = await agent.patch('/api/admin/settings/wall_chores_dwell_sec').send({ value: '4' });
  assert.equal(a.status, 400);
  const b = await agent.patch('/api/admin/settings/wall_chores_dwell_sec').send({ value: '601' });
  assert.equal(b.status, 400);
});

test('PATCH wall_weather_lat accepts empty, 0, 90, -90 and rejects 91', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  for (const v of ['', '0', '90', '-90']) {
    const r = await agent.patch('/api/admin/settings/wall_weather_lat').send({ value: v });
    assert.equal(r.status, 200, `expected 200 for ${JSON.stringify(v)} got ${r.status}`);
  }
  const bad = await agent.patch('/api/admin/settings/wall_weather_lat').send({ value: '91' });
  assert.equal(bad.status, 400);
});

test('PATCH wall_weather_unit accepts F and C only', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  assert.equal((await agent.patch('/api/admin/settings/wall_weather_unit').send({ value: 'F' })).status, 200);
  assert.equal((await agent.patch('/api/admin/settings/wall_weather_unit').send({ value: 'C' })).status, 200);
  assert.equal((await agent.patch('/api/admin/settings/wall_weather_unit').send({ value: 'K' })).status, 400);
});

test('PATCH wall_sleep_start accepts 22:00 and rejects 25:00', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  assert.equal((await agent.patch('/api/admin/settings/wall_sleep_start').send({ value: '22:00' })).status, 200);
  assert.equal((await agent.patch('/api/admin/settings/wall_sleep_start').send({ value: '25:00' })).status, 400);
});

test('PATCH wall_sleep_clock_style accepts the three known values', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  for (const v of ['digital', 'analog-minimal', 'analog-classic']) {
    assert.equal((await agent.patch('/api/admin/settings/wall_sleep_clock_style').send({ value: v })).status, 200);
  }
  assert.equal((await agent.patch('/api/admin/settings/wall_sleep_clock_style').send({ value: 'apple' })).status, 400);
});
```

- [ ] **Step 5: Run tests and confirm pass**

Run: `cd ~/projects/tally && node --test tests/routes-admin-settings-wall.test.js 2>&1 | tail -10`
Expected: 9 tests, 9 passing.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/tally && git add src/migrations/012-wall-suite.sql src/routes/admin/settings.js tests/routes-admin-settings-wall.test.js && git commit -m "feat(settings): wall-suite migration 012 + 9 new whitelisted keys with validators"
```

---

## Task 2: `/api/wall/config` route

**Files:**
- Modify: `src/routes/wall.js`
- Test: `tests/routes-wall-config.test.js`

- [ ] **Step 1: Write failing test**

Create `tests/routes-wall-config.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';

test('GET /api/wall/config returns the wall-public settings (no auth required)', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const res = await request(app).get('/api/wall/config');
  assert.equal(res.status, 200);
  const c = res.body;
  assert.equal(c.enabled_panels, 'chores,weather,calendar,verse-fact');
  assert.equal(c.chores_dwell_sec, 60);
  assert.equal(c.other_dwell_sec, 15);
  assert.equal(c.weather_unit, 'F');
  assert.equal(c.sleep_start, '22:00');
  assert.equal(c.sleep_end, '06:00');
  assert.equal(c.sleep_clock_style, 'analog-minimal');
  // Must NOT include encrypted refresh token or any non-wall_* key.
  assert.equal(c.admin_pin_hash, undefined);
  assert.equal(c.wall_calendar_oauth_refresh, undefined);
});

test('GET /api/wall/config reflects updated settings', async () => {
  const db = freshDb();
  const app = freshApp(db);
  db.prepare("UPDATE settings SET value = ? WHERE key = ?").run('40', 'wall_chores_dwell_sec');
  const res = await request(app).get('/api/wall/config');
  assert.equal(res.body.chores_dwell_sec, 40);
});
```

- [ ] **Step 2: Run failing test**

Run: `cd ~/projects/tally && node --test tests/routes-wall-config.test.js 2>&1 | tail -5`
Expected: FAIL (404 — endpoint missing).

- [ ] **Step 3: Add the route**

In `src/routes/wall.js`, inside `wallRoutes()` and BEFORE the existing `r.get('/wall', ...)` route, insert:

```js
  r.get('/wall/config', (req, res) => {
    const db = req.app.get('db');
    const rows = db.prepare(
      "SELECT key, value FROM settings WHERE key LIKE 'wall\\_%' ESCAPE '\\'"
    ).all();
    const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
    res.json({
      enabled_panels:    s.wall_enabled_panels || 'chores',
      chores_dwell_sec:  Number(s.wall_chores_dwell_sec || 60),
      other_dwell_sec:   Number(s.wall_other_dwell_sec || 15),
      weather_lat:       s.wall_weather_lat || '',
      weather_lon:       s.wall_weather_lon || '',
      weather_unit:      s.wall_weather_unit || 'F',
      sleep_start:       s.wall_sleep_start || '22:00',
      sleep_end:         s.wall_sleep_end || '06:00',
      sleep_clock_style: s.wall_sleep_clock_style || 'analog-minimal',
    });
  });
```

- [ ] **Step 4: Run tests and confirm pass**

Run: `cd ~/projects/tally && node --test tests/routes-wall-config.test.js 2>&1 | tail -5`
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/routes/wall.js tests/routes-wall-config.test.js && git commit -m "feat(wall): GET /api/wall/config exposes wall-public settings"
```

---

## Task 3: Open-Meteo client + WMO theme mapping

**Files:**
- Create: `src/lib/wall/open-meteo.js`
- Test: `tests/lib-wall-open-meteo.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/lib-wall-open-meteo.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapWmoToTheme, parseForecast } from '../src/lib/wall/open-meteo.js';

test('mapWmoToTheme handles clear day and night', () => {
  assert.equal(mapWmoToTheme(0, true),  'clear-day');
  assert.equal(mapWmoToTheme(0, false), 'clear-night');
  assert.equal(mapWmoToTheme(1, true),  'clear-day');
});

test('mapWmoToTheme handles partly-cloudy', () => {
  assert.equal(mapWmoToTheme(2, true),  'partly-cloudy');
  assert.equal(mapWmoToTheme(3, true),  'overcast');
});

test('mapWmoToTheme handles fog', () => {
  assert.equal(mapWmoToTheme(45, true), 'fog');
  assert.equal(mapWmoToTheme(48, false), 'fog');
});

test('mapWmoToTheme handles drizzle and rain', () => {
  assert.equal(mapWmoToTheme(51, true), 'rain');
  assert.equal(mapWmoToTheme(61, true), 'rain');
  assert.equal(mapWmoToTheme(80, true), 'rain');
});

test('mapWmoToTheme handles snow', () => {
  assert.equal(mapWmoToTheme(71, true), 'snow');
  assert.equal(mapWmoToTheme(77, true), 'snow');
  assert.equal(mapWmoToTheme(85, true), 'snow');
});

test('mapWmoToTheme handles thunderstorm', () => {
  assert.equal(mapWmoToTheme(95, true), 'thunderstorm');
  assert.equal(mapWmoToTheme(99, true), 'thunderstorm');
});

test('mapWmoToTheme falls back to overcast on unknown codes', () => {
  assert.equal(mapWmoToTheme(123, true), 'overcast');
});

test('parseForecast extracts current + today + 3-day forecast', () => {
  const apiResponse = {
    current: { temperature_2m: 72.4, weather_code: 2, is_day: 1 },
    daily: {
      time: ['2026-06-01','2026-06-02','2026-06-03','2026-06-04'],
      weather_code: [2, 61, 0, 71],
      temperature_2m_max: [85.1, 78.0, 90.0, 30.5],
      temperature_2m_min: [62.0, 60.5, 70.0, 20.1],
      sunrise: ['2026-06-01T06:15','2026-06-02T06:14','2026-06-03T06:14','2026-06-04T06:13'],
      sunset:  ['2026-06-01T20:30','2026-06-02T20:31','2026-06-03T20:32','2026-06-04T20:33'],
    },
  };
  const f = parseForecast(apiResponse);
  assert.equal(f.current_temp, 72);
  assert.equal(f.theme, 'partly-cloudy');
  assert.equal(f.today_high, 85);
  assert.equal(f.today_low,  62);
  assert.equal(f.forecast.length, 3);
  assert.equal(f.forecast[0].day_iso, '2026-06-02');
  assert.equal(f.forecast[0].theme, 'rain');
  assert.equal(f.forecast[0].high, 78);
  assert.equal(f.forecast[1].theme, 'clear-day');
  assert.equal(f.forecast[2].theme, 'snow');
});
```

- [ ] **Step 2: Run failing tests**

Run: `cd ~/projects/tally && node --test tests/lib-wall-open-meteo.test.js 2>&1 | tail -5`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the client**

Create `src/lib/wall/open-meteo.js`:

```js
// Open-Meteo client. No API key. Caches handled by the caller (the route).
//
// WMO weather codes:
//   0       clear sky
//   1, 2, 3 mainly clear / partly cloudy / overcast
//   45, 48  fog
//   51-67   drizzle / rain (incl. freezing variants)
//   71-77   snow
//   80-82   rain showers
//   85, 86  snow showers
//   95-99   thunderstorm

const THEME_BY_CODE = new Map([
  [0, 'clear'],
  [1, 'clear'],
  [2, 'partly-cloudy'],
  [3, 'overcast'],
  [45, 'fog'], [48, 'fog'],
  [51, 'rain'], [53, 'rain'], [55, 'rain'],
  [56, 'rain'], [57, 'rain'],
  [61, 'rain'], [63, 'rain'], [65, 'rain'],
  [66, 'rain'], [67, 'rain'],
  [71, 'snow'], [73, 'snow'], [75, 'snow'], [77, 'snow'],
  [80, 'rain'], [81, 'rain'], [82, 'rain'],
  [85, 'snow'], [86, 'snow'],
  [95, 'thunderstorm'], [96, 'thunderstorm'], [99, 'thunderstorm'],
]);

export function mapWmoToTheme(code, isDay) {
  const t = THEME_BY_CODE.get(code) || 'overcast';
  if (t === 'clear') return isDay ? 'clear-day' : 'clear-night';
  return t;
}

export function parseForecast(json) {
  const cur = json.current || {};
  const d = json.daily || {};
  const todayHigh = Math.round(d.temperature_2m_max?.[0] ?? 0);
  const todayLow  = Math.round(d.temperature_2m_min?.[0] ?? 0);
  const forecast = [];
  for (let i = 1; i <= 3 && i < (d.time?.length || 0); i++) {
    forecast.push({
      day_iso: d.time[i],
      theme:   mapWmoToTheme(d.weather_code?.[i] ?? -1, true),
      high:    Math.round(d.temperature_2m_max?.[i] ?? 0),
      low:     Math.round(d.temperature_2m_min?.[i] ?? 0),
    });
  }
  return {
    current_temp: Math.round(cur.temperature_2m ?? 0),
    theme:        mapWmoToTheme(cur.weather_code ?? -1, !!cur.is_day),
    today_high:   todayHigh,
    today_low:    todayLow,
    forecast,
  };
}

// Live fetch. Caller is responsible for caching.
// unit: 'F' | 'C'
export async function fetchOpenMeteo(lat, lon, unit = 'F') {
  const tempUnit = unit === 'C' ? 'celsius' : 'fahrenheit';
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude',  String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('current',   'temperature_2m,weather_code,is_day');
  url.searchParams.set('daily',     'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset');
  url.searchParams.set('temperature_unit', tempUnit);
  url.searchParams.set('timezone',  'auto');
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`open-meteo ${r.status}`);
  return await r.json();
}
```

- [ ] **Step 4: Run tests and confirm pass**

Run: `cd ~/projects/tally && node --test tests/lib-wall-open-meteo.test.js 2>&1 | tail -5`
Expected: 8 passing.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/lib/wall/open-meteo.js tests/lib-wall-open-meteo.test.js && git commit -m "feat(wall): Open-Meteo client and WMO -> theme mapping"
```

---

## Task 4: `/api/wall/weather` route with cache + skip rule

**Files:**
- Modify: `src/routes/wall.js`
- Test: `tests/routes-wall-weather.test.js`

- [ ] **Step 1: Write failing test**

Create `tests/routes-wall-weather.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';
import { _resetWeatherState } from '../src/routes/wall.js';

const SAMPLE_API = {
  current: { temperature_2m: 73.1, weather_code: 0, is_day: 1 },
  daily: {
    time: ['2026-06-01','2026-06-02','2026-06-03','2026-06-04'],
    weather_code: [0, 2, 61, 0],
    temperature_2m_max: [85, 80, 75, 88],
    temperature_2m_min: [62, 60, 58, 65],
    sunrise: ['2026-06-01T06:00','2026-06-02T06:00','2026-06-03T06:00','2026-06-04T06:00'],
    sunset:  ['2026-06-01T20:30','2026-06-02T20:30','2026-06-03T20:30','2026-06-04T20:30'],
  },
};

test('GET /api/wall/weather returns skip when location is not set', async () => {
  _resetWeatherState();
  const db = freshDb();
  const app = freshApp(db);
  const r = await request(app).get('/api/wall/weather');
  assert.equal(r.status, 200);
  assert.equal(r.body.skip, true);
  assert.match(r.body.reason || '', /location/i);
});

test('GET /api/wall/weather returns mapped forecast when location is set and fetch succeeds', async () => {
  _resetWeatherState();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => SAMPLE_API });
  try {
    const db = freshDb();
    db.prepare("UPDATE settings SET value=? WHERE key='wall_weather_lat'").run('30.5');
    db.prepare("UPDATE settings SET value=? WHERE key='wall_weather_lon'").run('-97.6');
    const app = freshApp(db);
    const r = await request(app).get('/api/wall/weather');
    assert.equal(r.status, 200);
    assert.equal(r.body.skip, undefined);
    assert.equal(r.body.theme, 'clear-day');
    assert.equal(r.body.current_temp, 73);
    assert.equal(r.body.forecast.length, 3);
    assert.equal(r.body.unit, 'F');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GET /api/wall/weather returns skip when fetch has failed for >30 minutes', async () => {
  _resetWeatherState();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const db = freshDb();
    db.prepare("UPDATE settings SET value=? WHERE key='wall_weather_lat'").run('30.5');
    db.prepare("UPDATE settings SET value=? WHERE key='wall_weather_lon'").run('-97.6');
    const app = freshApp(db);
    // First failure: no cache yet, no prior success — must skip.
    const r1 = await request(app).get('/api/wall/weather');
    assert.equal(r1.body.skip, true);
    assert.match(r1.body.reason || '', /fetch failed/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Run failing test**

Run: `cd ~/projects/tally && node --test tests/routes-wall-weather.test.js 2>&1 | tail -5`
Expected: FAIL (`_resetWeatherState` not exported, route 404).

- [ ] **Step 3: Add weather state + route**

At the top of `src/routes/wall.js` (after the imports, before `wallRoutes`), add:

```js
import { fetchOpenMeteo, parseForecast } from '../lib/wall/open-meteo.js';

// In-memory weather cache. Tied to the module so it persists for the process lifetime.
let weatherCache = null;       // { key, data, fetchedAt }
let weatherLastSuccess = 0;    // epoch ms of last successful fetch
let weatherLastFailureLog = 0; // dedupe log lines on repeated failures

const WEATHER_CACHE_MS = 10 * 60 * 1000;
const WEATHER_STALE_SKIP_MS = 30 * 60 * 1000;

export function _resetWeatherState() {
  weatherCache = null;
  weatherLastSuccess = 0;
  weatherLastFailureLog = 0;
}
```

Inside `wallRoutes()`, after the `wall/config` route added in Task 2, insert:

```js
  r.get('/wall/weather', async (req, res) => {
    const db = req.app.get('db');
    const rows = db.prepare(
      "SELECT key, value FROM settings WHERE key IN ('wall_weather_lat','wall_weather_lon','wall_weather_unit')"
    ).all();
    const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
    const lat = s.wall_weather_lat;
    const lon = s.wall_weather_lon;
    const unit = s.wall_weather_unit || 'F';
    if (!lat || !lon) return res.json({ skip: true, reason: 'no location configured' });

    const cacheKey = `${lat},${lon},${unit}`;
    const now = Date.now();
    if (weatherCache && weatherCache.key === cacheKey && (now - weatherCache.fetchedAt) < WEATHER_CACHE_MS) {
      return res.json({ ...weatherCache.data, unit });
    }
    try {
      const raw = await fetchOpenMeteo(lat, lon, unit);
      const parsed = parseForecast(raw);
      weatherCache = { key: cacheKey, data: parsed, fetchedAt: now };
      weatherLastSuccess = now;
      return res.json({ ...parsed, unit });
    } catch (err) {
      // Dedupe error logs to once per 5 min.
      if (now - weatherLastFailureLog > 5 * 60 * 1000) {
        console.error('[wall/weather] fetch failed:', err.message);
        weatherLastFailureLog = now;
      }
      // If we have a recent successful cache (within the stale-skip window), serve it.
      if (weatherCache && weatherCache.key === cacheKey && (now - weatherLastSuccess) < WEATHER_STALE_SKIP_MS) {
        return res.json({ ...weatherCache.data, unit, stale: true });
      }
      return res.json({ skip: true, reason: 'fetch failed' });
    }
  });
```

- [ ] **Step 4: Run tests and confirm pass**

Run: `cd ~/projects/tally && node --test tests/routes-wall-weather.test.js 2>&1 | tail -5`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/routes/wall.js tests/routes-wall-weather.test.js && git commit -m "feat(wall): /api/wall/weather route with 10-min cache and 30-min stale-skip"
```

---

## Task 5: Rotation cursor library

**Files:**
- Create: `public/js/wall/rotation.js`  (browser-side; pure ESM logic, no Node deps, tests import from here too)
- Test: `tests/lib-wall-rotation.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/lib-wall-rotation.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rotation } from '../public/js/wall/rotation.js';

test('Rotation with chores only never advances', () => {
  const r = new Rotation(['chores']);
  assert.equal(r.current(), 'chores');
  r.advance(() => false);
  assert.equal(r.current(), 'chores');
});

test('Rotation with chores+weather alternates chores <-> weather', () => {
  const r = new Rotation(['chores','weather']);
  assert.equal(r.current(), 'chores');
  r.advance(() => false);
  assert.equal(r.current(), 'weather');
  r.advance(() => false);
  assert.equal(r.current(), 'chores');
  r.advance(() => false);
  assert.equal(r.current(), 'weather');
});

test('Rotation cycles through others in order between chores visits', () => {
  const r = new Rotation(['chores','weather','calendar','verse-fact']);
  const visited = [];
  for (let i = 0; i < 8; i++) { visited.push(r.current()); r.advance(() => false); }
  assert.deepEqual(visited, ['chores','weather','chores','calendar','chores','verse-fact','chores','weather']);
});

test('Rotation skips a panel that reports skip=true on the same tick', () => {
  const r = new Rotation(['chores','weather','calendar','verse-fact']);
  r.advance(() => false);              // chores -> weather
  // From weather we'd next go to chores; the rotation's job is to pick "next other"
  // so let's drive forward two more hops and skip calendar when it would land.
  r.advance(() => false);              // weather -> chores
  // Next is "calendar" — skip it.
  r.advance(p => p === 'calendar');    // chores -> calendar (skipped) -> verse-fact
  assert.equal(r.current(), 'verse-fact');
});

test('Rotation handles all-others-skip by parking on chores', () => {
  const r = new Rotation(['chores','weather','calendar']);
  // We're on chores; advance with everything-else-skip should keep us on chores.
  r.advance(p => p !== 'chores');
  assert.equal(r.current(), 'chores');
});

test('Rotation: nextDwellMs returns the appropriate dwell for current panel', () => {
  const r = new Rotation(['chores','weather'], { choresDwellSec: 60, otherDwellSec: 15 });
  assert.equal(r.nextDwellMs(), 60_000);
  r.advance(() => false);
  assert.equal(r.nextDwellMs(), 15_000);
});

test('Rotation: setEnabled swaps the panel list and resets to chores if missing', () => {
  const r = new Rotation(['chores','weather','calendar']);
  r.advance(() => false);                  // -> weather
  r.setEnabled(['chores','verse-fact']);
  assert.equal(r.current(), 'chores');
});
```

- [ ] **Step 2: Run failing tests**

Run: `cd ~/projects/tally && node --test tests/lib-wall-rotation.test.js 2>&1 | tail -5`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement Rotation**

Create `public/js/wall/rotation.js`:

```js
// Rotation: chores-heavy smart cycle.
//
// Pattern with [chores, A, B, C] enabled:
//   chores  A  chores  B  chores  C  chores  A  ...
//
// Internal state: `_current` is the panel currently shown; `_otherIdx` is the
// position in the others list of the NEXT "other" panel to visit.

const MAX_SKIP_HOPS = 16; // safety against infinite skip loops

export class Rotation {
  constructor(enabled, { choresDwellSec = 60, otherDwellSec = 15 } = {}) {
    this._choresMs = choresDwellSec * 1000;
    this._otherMs  = otherDwellSec  * 1000;
    this.setEnabled(enabled);
  }

  setEnabled(enabled) {
    this._enabled = enabled.slice();
    this._others = this._enabled.filter(p => p !== 'chores');
    this._otherIdx = 0;
    this._current = 'chores';
  }

  current() { return this._current; }

  nextDwellMs() {
    return this._current === 'chores' ? this._choresMs : this._otherMs;
  }

  // shouldSkip(panelKey) -> bool. Called by advance() when it picks a candidate.
  advance(shouldSkip) {
    if (this._others.length === 0) return;
    if (this._current !== 'chores') {
      this._current = 'chores';
      return;
    }
    // We're on chores; pick the next non-chores panel, honoring skip.
    let hops = 0;
    while (hops < MAX_SKIP_HOPS) {
      const candidate = this._others[this._otherIdx % this._others.length];
      this._otherIdx = (this._otherIdx + 1) % this._others.length;
      if (!shouldSkip(candidate)) {
        this._current = candidate;
        return;
      }
      hops++;
    }
    // All others skipped; park on chores.
    this._current = 'chores';
  }
}
```

- [ ] **Step 4: Run tests and confirm pass**

Run: `cd ~/projects/tally && node --test tests/lib-wall-rotation.test.js 2>&1 | tail -5`
Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add public/js/wall/rotation.js tests/lib-wall-rotation.test.js && git commit -m "feat(wall): Rotation cursor walker with chores-home-base smart cycle"
```

---

## Task 6: Sleep-window library

**Files:**
- Create: `public/js/wall/sleep.js`  (browser-side; pure ESM logic, no Node deps, tests import from here too)
- Test: `tests/lib-wall-sleep.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/lib-wall-sleep.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInSleepWindow } from '../public/js/wall/sleep.js';

test('isInSleepWindow: simple in-window case (no midnight wrap)', () => {
  assert.equal(isInSleepWindow('13:00', '08:00', '17:00'), true);
  assert.equal(isInSleepWindow('07:59', '08:00', '17:00'), false);
  assert.equal(isInSleepWindow('17:01', '08:00', '17:00'), false);
});

test('isInSleepWindow: boundary inclusivity', () => {
  // Start is inclusive, end is exclusive — so 08:00 in, 17:00 out.
  assert.equal(isInSleepWindow('08:00', '08:00', '17:00'), true);
  assert.equal(isInSleepWindow('17:00', '08:00', '17:00'), false);
});

test('isInSleepWindow: midnight wrap', () => {
  assert.equal(isInSleepWindow('23:30', '22:00', '06:00'), true);
  assert.equal(isInSleepWindow('00:30', '22:00', '06:00'), true);
  assert.equal(isInSleepWindow('05:59', '22:00', '06:00'), true);
  assert.equal(isInSleepWindow('06:00', '22:00', '06:00'), false);
  assert.equal(isInSleepWindow('21:59', '22:00', '06:00'), false);
  assert.equal(isInSleepWindow('22:00', '22:00', '06:00'), true);
});

test('isInSleepWindow: empty window (start == end) is never sleeping', () => {
  assert.equal(isInSleepWindow('00:00', '12:00', '12:00'), false);
  assert.equal(isInSleepWindow('12:00', '12:00', '12:00'), false);
});
```

- [ ] **Step 2: Run failing tests**

Run: `cd ~/projects/tally && node --test tests/lib-wall-sleep.test.js 2>&1 | tail -5`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement isInSleepWindow**

Create `public/js/wall/sleep.js`:

```js
// Sleep-window calculation. All inputs are HH:MM strings in local 24-hour time.
//
// Start is inclusive; end is exclusive. A window where start == end is
// treated as "no sleep at all" (handy for "disable sleep mode" config).
// Midnight-wrapping windows (start > end, e.g. 22:00..06:00) are supported.

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function isInSleepWindow(now, start, end) {
  const n = toMinutes(now);
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === e) return false;
  if (s < e) return n >= s && n < e;
  // wrap: [s..24:00) U [00:00..e)
  return n >= s || n < e;
}
```

- [ ] **Step 4: Run tests and confirm pass**

Run: `cd ~/projects/tally && node --test tests/lib-wall-sleep.test.js 2>&1 | tail -5`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add public/js/wall/sleep.js tests/lib-wall-sleep.test.js && git commit -m "feat(wall): isInSleepWindow with midnight-wrap support"
```

---

## Task 7: Wall HTML skeleton + base CSS

**Files:**
- Modify: `public/wall.html`
- Create: `public/css/wall-suite.css`

- [ ] **Step 1: Update wall.html**

Replace the contents of `public/wall.html` entirely with:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tally · Wall</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/css/tokens.css" />
  <link rel="stylesheet" href="/css/base.css" />
  <link rel="stylesheet" href="/css/components.css" />
  <link rel="stylesheet" href="/css/layouts.css" />
  <link rel="stylesheet" href="/css/wall-suite.css" />
  <style>html, body { overflow: hidden; margin: 0; padding: 0; }</style>
</head>
<body>
  <div id="wall-root">
    <header id="wall-header"></header>
    <main id="wall-stage"></main>
  </div>
  <div id="wall-sleep" hidden></div>
  <script type="module" src="/js/pages/wall.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create base wall-suite.css**

Create `public/css/wall-suite.css`:

```css
/* Wall Suite layout: persistent header on top, stage takes the rest. */
#wall-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  background: var(--bg, #0b1220);
  color: var(--ink, #e8ecf3);
  font-family: 'Inter', system-ui, sans-serif;
}

#wall-header {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  padding: 18px 28px;
  font-size: 1.6rem;
  font-weight: 600;
  letter-spacing: 0.01em;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
#wall-header .clock { justify-self: start; font-variant-numeric: tabular-nums; }
#wall-header .date  { justify-self: center; opacity: 0.85; }
#wall-header .leader { justify-self: end; font-size: 1.0rem; opacity: 0.85; display: flex; gap: 8px; align-items: center; }
#wall-header .leader .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }

#wall-stage {
  flex: 1 1 auto;
  position: relative;
  overflow: hidden;
}

/* Panels live inside the stage as absolutely-positioned layers
   so cross-fade works without layout thrash. */
.wall-panel {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.4s ease;
  padding: 24px 32px;
}
.wall-panel.is-active { opacity: 1; z-index: 1; }
.wall-panel.is-leaving { z-index: 0; }

/* Sleep overlay covers everything. */
#wall-sleep {
  position: fixed;
  inset: 0;
  background: #000;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
}
#wall-sleep .sleep-face {
  position: absolute;
  color: rgba(255,255,255,0.12);
  transition: transform 3s ease;
  font-variant-numeric: tabular-nums;
  user-select: none;
  pointer-events: none;
}
#wall-sleep .sleep-face.digital { font-size: 25vh; font-weight: 600; letter-spacing: 0.02em; }
#wall-sleep .sleep-face.analog  { width: 30vh; height: 30vh; }

/* Weather panel themes. Each sets a background + accent. */
.weather-theme-clear-day      { background: linear-gradient(160deg, #FBBF24 0%, #38BDF8 70%, #0EA5E9 100%); }
.weather-theme-clear-night    { background: linear-gradient(180deg, #0F172A 0%, #1E1B4B 100%); }
.weather-theme-partly-cloudy  { background: linear-gradient(170deg, #93C5FD 0%, #60A5FA 80%); }
.weather-theme-overcast       { background: linear-gradient(180deg, #475569 0%, #334155 100%); }
.weather-theme-rain           { background: linear-gradient(180deg, #1E293B 0%, #334155 100%); }
.weather-theme-thunderstorm   { background: linear-gradient(180deg, #0B1220 0%, #1E293B 100%); }
.weather-theme-snow           { background: linear-gradient(180deg, #E2E8F0 0%, #94A3B8 100%); color: #0F172A; }
.weather-theme-fog            { background: linear-gradient(180deg, #94A3B8 0%, #64748B 100%); }

/* Weather-panel content layout. */
.weather-current { text-align: center; }
.weather-current .temp { font-size: 14vh; font-weight: 700; line-height: 0.9; }
.weather-current .hilo { font-size: 2.2rem; opacity: 0.9; margin-top: 12px; }
.weather-forecast { display: flex; gap: 24px; margin-top: 36px; justify-content: center; }
.weather-forecast .day { text-align: center; opacity: 0.95; }
.weather-forecast .day .label { font-size: 1.0rem; opacity: 0.85; text-transform: uppercase; letter-spacing: 0.06em; }
.weather-forecast .day .ico { font-size: 3rem; line-height: 1; margin: 6px 0; }
.weather-forecast .day .hilo { font-size: 1.4rem; font-variant-numeric: tabular-nums; }

/* Subtle rain animation: 3 droplet layers via pseudo-elements. */
.weather-theme-rain::before,
.weather-theme-rain::after {
  content: '';
  position: absolute; inset: 0;
  background-image:
    radial-gradient(circle 1px at 20% 30%, rgba(255,255,255,0.5) 1px, transparent 2px),
    radial-gradient(circle 1px at 50% 60%, rgba(255,255,255,0.4) 1px, transparent 2px),
    radial-gradient(circle 1px at 80% 20%, rgba(255,255,255,0.6) 1px, transparent 2px);
  background-size: 200px 200px;
  animation: rainfall 2.5s linear infinite;
  pointer-events: none;
}
.weather-theme-rain::after { animation-delay: -1.2s; opacity: 0.7; }
@keyframes rainfall {
  from { transform: translateY(-100px); }
  to   { transform: translateY(100px); }
}

/* Snow animation: slower drift. */
.weather-theme-snow::before {
  content: '';
  position: absolute; inset: 0;
  background-image:
    radial-gradient(circle 2px at 25% 10%, rgba(255,255,255,0.95) 2px, transparent 3px),
    radial-gradient(circle 2px at 60% 40%, rgba(255,255,255,0.85) 2px, transparent 3px),
    radial-gradient(circle 2px at 90% 70%, rgba(255,255,255,0.9)  2px, transparent 3px);
  background-size: 220px 220px;
  animation: snowfall 12s linear infinite;
  pointer-events: none;
}
@keyframes snowfall {
  from { transform: translateY(-80px); }
  to   { transform: translateY(120px); }
}

/* Thunderstorm flash overlay. */
.weather-theme-thunderstorm::before {
  content: '';
  position: absolute; inset: 0;
  background: rgba(255,255,255,0);
  animation: lightning 9s infinite;
  pointer-events: none;
}
@keyframes lightning {
  0%, 95%, 100% { background: rgba(255,255,255,0); }
  96%, 97%      { background: rgba(255,255,255,0.55); }
  98%           { background: rgba(255,255,255,0.2); }
}

/* Clear-night stars. */
.weather-theme-clear-night::before {
  content: '';
  position: absolute; inset: 0;
  background-image:
    radial-gradient(circle 1px at 15% 22%, rgba(255,255,255,0.85) 1px, transparent 2px),
    radial-gradient(circle 1px at 40% 70%, rgba(255,255,255,0.7) 1px, transparent 2px),
    radial-gradient(circle 1px at 75% 15%, rgba(255,255,255,0.9) 1px, transparent 2px),
    radial-gradient(circle 1px at 88% 55%, rgba(255,255,255,0.8) 1px, transparent 2px);
  background-size: 320px 320px;
  pointer-events: none;
}
```

- [ ] **Step 3: Commit (no test step — purely structural HTML/CSS)**

```bash
cd ~/projects/tally && git add public/wall.html public/css/wall-suite.css && git commit -m "feat(wall): HTML skeleton and base CSS for Wall Suite layout/themes"
```

---

## Task 8: Persistent header module

**Files:**
- Create: `public/js/wall/header.js`

- [ ] **Step 1: Write the header module**

Create `public/js/wall/header.js`:

```js
// Persistent header for the Wall Suite.
// Updates clock every second; date and streak leader come from wall data on each refresh.

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function fmtTime(d) {
  const h = d.getHours() % 12 || 12;
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = d.getHours() < 12 ? 'AM' : 'PM';
  return `${h}:${m} ${ampm}`;
}

function fmtDate(d) {
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export class Header {
  constructor(hostEl) {
    this.host = hostEl;
    this.clockEl = null;
    this.dateEl = null;
    this.leaderEl = null;
    this.tick = null;
  }

  mount() {
    this.host.innerHTML = `
      <span class="clock"></span>
      <span class="date"></span>
      <span class="leader" hidden><span class="dot"></span><span class="text"></span></span>
    `;
    this.clockEl  = this.host.querySelector('.clock');
    this.dateEl   = this.host.querySelector('.date');
    this.leaderEl = this.host.querySelector('.leader');
    this._refreshClock();
    this.tick = setInterval(() => this._refreshClock(), 1000);
  }

  unmount() {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    this.host.innerHTML = '';
  }

  // streak: { name, color, streak_days } | null
  setStreakLeader(streak) {
    if (!streak) { this.leaderEl.hidden = true; return; }
    this.leaderEl.hidden = false;
    this.leaderEl.querySelector('.dot').style.background = streak.color || '#22C55E';
    this.leaderEl.querySelector('.text').textContent = `${streak.name} · ${streak.streak_days}d streak`;
  }

  hide()  { this.host.hidden = true; }
  show()  { this.host.hidden = false; }

  _refreshClock() {
    const now = new Date();
    this.clockEl.textContent = fmtTime(now);
    this.dateEl.textContent  = fmtDate(now);
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd ~/projects/tally && git add public/js/wall/header.js && git commit -m "feat(wall): persistent header module (clock + date + streak leader)"
```

---

## Task 9: Sleep clock module (digital + analog-minimal + analog-classic + drift)

**Files:**
- Create: `public/js/wall/sleep-clock.js`

- [ ] **Step 1: Write the sleep-clock module**

Create `public/js/wall/sleep-clock.js`:

```js
// Drifting dim clock used during sleep mode.
// Repositions every 60s with a 3s ease transition to defeat burn-in.

function pad(n) { return String(n).padStart(2, '0'); }

function pickPosition() {
  // Stay no closer than 15% to any edge.
  const x = 15 + Math.floor(Math.random() * 70); // 15..85
  const y = 15 + Math.floor(Math.random() * 70);
  return { x, y };
}

function renderAnalogSVG(showNumerals) {
  // Static SVG markup; hands are rotated via inline transforms updated each tick.
  const ticks = Array.from({length: 12}, (_, i) => {
    const angle = i * 30;
    return `<line x1="50" y1="6" x2="50" y2="12" stroke="currentColor" stroke-width="1.2" transform="rotate(${angle} 50 50)" />`;
  }).join('');
  const numerals = showNumerals ? `
    <text x="50" y="16" text-anchor="middle" font-size="9" fill="currentColor">12</text>
    <text x="86" y="53" text-anchor="middle" font-size="9" fill="currentColor">3</text>
    <text x="50" y="90" text-anchor="middle" font-size="9" fill="currentColor">6</text>
    <text x="14" y="53" text-anchor="middle" font-size="9" fill="currentColor">9</text>
  ` : '';
  return `
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">
      <circle cx="50" cy="50" r="48" fill="none" stroke="currentColor" stroke-width="0.6" />
      ${ticks}
      ${numerals}
      <line class="hand-hour"   x1="50" y1="50" x2="50" y2="28" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" transform="rotate(0 50 50)" />
      <line class="hand-minute" x1="50" y1="50" x2="50" y2="18" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" transform="rotate(0 50 50)" />
      <circle cx="50" cy="50" r="1.5" fill="currentColor" />
    </svg>
  `;
}

export class SleepClock {
  constructor(hostEl, style = 'analog-minimal') {
    this.host = hostEl;
    this.style = style;
    this.faceEl = null;
    this.tick = null;
    this.driftTimer = null;
  }

  mount() {
    this.host.hidden = false;
    this.host.innerHTML = '';
    this.faceEl = document.createElement('div');
    this.faceEl.className = 'sleep-face ' + (this.style === 'digital' ? 'digital' : 'analog');
    if (this.style === 'digital') {
      this.faceEl.textContent = this._currentDigital();
    } else {
      this.faceEl.innerHTML = renderAnalogSVG(this.style === 'analog-classic');
    }
    this.host.appendChild(this.faceEl);
    this._reposition();
    this.tick = setInterval(() => this._refresh(), 1000);
    this.driftTimer = setInterval(() => this._reposition(), 60_000);
  }

  unmount() {
    if (this.tick) clearInterval(this.tick);
    if (this.driftTimer) clearInterval(this.driftTimer);
    this.tick = null; this.driftTimer = null;
    this.host.innerHTML = '';
    this.host.hidden = true;
  }

  _currentDigital() {
    const d = new Date();
    const h = d.getHours() % 12 || 12;
    return `${h}:${pad(d.getMinutes())}`;
  }

  _refresh() {
    if (this.style === 'digital') {
      this.faceEl.textContent = this._currentDigital();
      return;
    }
    const d = new Date();
    const minutes = d.getMinutes();
    const hours = d.getHours() % 12 + minutes / 60;
    const hourAngle = hours * 30;       // 360 / 12
    const minuteAngle = minutes * 6;    // 360 / 60
    const hourHand   = this.faceEl.querySelector('.hand-hour');
    const minuteHand = this.faceEl.querySelector('.hand-minute');
    if (hourHand)   hourHand.setAttribute('transform',   `rotate(${hourAngle} 50 50)`);
    if (minuteHand) minuteHand.setAttribute('transform', `rotate(${minuteAngle} 50 50)`);
  }

  _reposition() {
    const { x, y } = pickPosition();
    this.faceEl.style.left = `${x}%`;
    this.faceEl.style.top  = `${y}%`;
    this.faceEl.style.transform = 'translate(-50%, -50%)';
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd ~/projects/tally && git add public/js/wall/sleep-clock.js && git commit -m "feat(wall): drifting dim sleep clock (digital + analog-minimal + analog-classic)"
```

---

## Task 10: Chores panel (port of existing wall logic)

**Files:**
- Create: `public/js/wall/panels/chores.js`

- [ ] **Step 1: Read the existing wall.js to preserve confetti + rendering**

```bash
cd ~/projects/tally && cat public/js/pages/wall.js
```

The existing logic does: fetch `/api/wall`, render kid cards with streak badges, trigger confetti on milestone hits, manage SSE refresh. The new chores panel needs to do all of that, but inside its mount host element.

- [ ] **Step 2: Write the chores panel**

Create `public/js/wall/panels/chores.js`:

```js
import { api } from '../../lib/api.js';
import { isMilestone, streakConfetti, milestoneConfetti } from '../../lib/confetti.js';

const wallStreakCache = new Map();
let firstRender = true;

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

function renderBody(host, data) {
  host.innerHTML = '';
  const banner = el('div', { class: 'wall-banner' }, [
    el('div', {}, [`${data.house_pct}% done today`]),
    el('div', { class: 'muted' }, [`${data.kids.length} kids · ${data.today}`]),
  ]);
  host.appendChild(banner);

  const grid = el('div', { class: 'wall-kid-grid' },
    data.kids.map(k => {
      const prevStreak = wallStreakCache.get(k.id) || 0;
      if (!firstRender && k.streak_days > prevStreak && isMilestone(k.streak_days)) {
        milestoneConfetti(k.avatar_color);
      } else if (!firstRender && k.streak_days > prevStreak) {
        streakConfetti(k.avatar_color);
      }
      wallStreakCache.set(k.id, k.streak_days);

      return el('div', { class: 'wall-kid' }, [
        el('div', { class: 'wall-kid-av', style: { background: k.avatar_color } }, [k.name[0]]),
        el('div', { class: 'wall-kid-name' }, [k.name]),
        el('div', { class: 'wall-kid-pct' }, [`${k.percent}%`]),
        k.streak_days > 0
          ? el('div', { class: 'wall-kid-streak' }, [`${k.streak_days}d streak`])
          : null,
        k.on_freeze ? el('div', { class: 'wall-kid-freeze' }, ['On freeze']) : null,
      ]);
    })
  );
  host.appendChild(grid);
  firstRender = false;
}

export default {
  key: 'chores',
  async fetch() {
    const data = await api.get('/api/wall').catch(() => null);
    if (!data) return { skip: true, reason: 'wall fetch failed' };
    return { data };
  },
  mount(host, data) {
    host.classList.add('wall-panel-chores');
    renderBody(host, data);
  },
  unmount() {
    // No timers to clear; SSE is managed by the stage.
  },
  refresh(data) {
    const host = document.querySelector('.wall-panel-chores');
    if (host && data) renderBody(host, data);
  },
  // Expose the parsed data's streak leader for the persistent header.
  extractStreakLeader(data) {
    return data?.streak_leader || null;
  },
};
```

- [ ] **Step 3: Commit**

```bash
cd ~/projects/tally && git add public/js/wall/panels/chores.js && git commit -m "feat(wall): chores panel module wraps the existing wall renderer"
```

---

## Task 11: Weather panel

**Files:**
- Create: `public/js/wall/panels/weather.js`

- [ ] **Step 1: Write the weather panel**

Create `public/js/wall/panels/weather.js`:

```js
import { api } from '../../lib/api.js';

const ICON = {
  'clear-day': '☀',
  'clear-night': '☾',
  'partly-cloudy': '⛅',
  'overcast': '☁',
  'fog': '🌫',
  'rain': '🌧',
  'snow': '❄',
  'thunderstorm': '⛈',
};

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function dayLabel(iso) {
  const d = new Date(iso + 'T00:00:00');
  return DAYS[d.getDay()];
}

export default {
  key: 'weather',
  async fetch() {
    const r = await api.get('/api/wall/weather').catch(() => null);
    if (!r) return { skip: true, reason: 'weather fetch error' };
    if (r.skip) return { skip: true, reason: r.reason };
    return { data: r };
  },
  mount(host, d) {
    host.classList.add('wall-panel-weather');
    // Reset theme classes, then apply this one.
    host.classList.forEach(c => { if (c.startsWith('weather-theme-')) host.classList.remove(c); });
    host.classList.add(`weather-theme-${d.theme}`);
    const u = d.unit === 'C' ? '°C' : '°F';
    host.innerHTML = `
      <div class="weather-current">
        <div class="temp">${d.current_temp}${u}</div>
        <div class="hilo">H ${d.today_high}${u} · L ${d.today_low}${u}</div>
        <div class="weather-forecast">
          ${d.forecast.map(f => `
            <div class="day">
              <div class="label">${dayLabel(f.day_iso)}</div>
              <div class="ico">${ICON[f.theme] || ICON.overcast}</div>
              <div class="hilo">${f.high}° / ${f.low}°</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  },
  unmount() {
    // No timers.
  },
};
```

- [ ] **Step 2: Commit**

```bash
cd ~/projects/tally && git add public/js/wall/panels/weather.js && git commit -m "feat(wall): weather panel module with theme-aware background"
```

---

## Task 12: Stage orchestrator + thin wall.js bootstrap

**Files:**
- Create: `public/js/wall/stage.js`
- Rewrite: `public/js/pages/wall.js`

- [ ] **Step 1: Write the stage orchestrator**

Create `public/js/wall/stage.js`:

```js
import { Rotation } from '/js/wall/rotation.js';  // resolved at module load time
import { Header } from '/js/wall/header.js';
import { SleepClock } from '/js/wall/sleep-clock.js';
import { isInSleepWindow } from '/js/wall/sleep.js';

import chores  from '/js/wall/panels/chores.js';
import weather from '/js/wall/panels/weather.js';

// Panel registry. Add new panel modules here as Phase 2/3 lands.
const PANEL_REGISTRY = { chores, weather };

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

export class Stage {
  constructor({ stageEl, headerEl, sleepEl }) {
    this.stageEl = stageEl;
    this.headerEl = headerEl;
    this.sleepEl = sleepEl;
    this.header = new Header(headerEl);
    this.sleepClock = null;

    this.config = null;
    this.rotation = null;
    this.activePanel = null;        // module reference of currently mounted panel
    this.activePanelEl = null;      // its mount host
    this.activeData = null;
    this.dwellTimer = null;
    this.sleepCheckTimer = null;
    this.sleeping = false;

    this.es = null;
    this.sseBackoffMs = 1000;
  }

  async start() {
    this.header.mount();
    this.config = await this._loadConfig();
    this.rotation = new Rotation(this._enabledPanels(), {
      choresDwellSec: this.config.chores_dwell_sec,
      otherDwellSec:  this.config.other_dwell_sec,
    });
    this.sleepCheckTimer = setInterval(() => this._checkSleep(), 60_000);
    this._checkSleep();
    if (!this.sleeping) await this._mountCurrent();
    this._openSSE();
  }

  async _loadConfig() {
    const r = await fetch('/api/wall/config').then(r => r.json());
    return r;
  }

  _enabledPanels() {
    return this.config.enabled_panels.split(',').map(s => s.trim()).filter(s => PANEL_REGISTRY[s] || s === 'chores');
  }

  async _mountCurrent() {
    const key = this.rotation.current();
    const mod = PANEL_REGISTRY[key];
    if (!mod) { this._scheduleNext(); return; }
    let result;
    try { result = await mod.fetch(); } catch { result = { skip: true, reason: 'fetch threw' }; }
    if (result?.skip) {
      this.rotation.advance(() => false);   // skip-on-fetch is handled by advancing now
      // If we're back on chores (no others enabled) just sit on chores even if its fetch failed.
      if (this.rotation.current() === key) return;
      return this._mountCurrent();
    }
    const host = document.createElement('div');
    host.className = 'wall-panel is-active';
    this.stageEl.appendChild(host);
    if (this.activePanelEl) {
      const old = this.activePanelEl;
      const oldMod = this.activePanel;
      old.classList.remove('is-active');
      old.classList.add('is-leaving');
      setTimeout(() => { try { oldMod?.unmount?.(); } catch {} old.remove(); }, 450);
    }
    this.activePanel = mod;
    this.activePanelEl = host;
    this.activeData = result.data;
    mod.mount(host, result.data);
    if (key === 'chores' && mod.extractStreakLeader) {
      this.header.setStreakLeader(mod.extractStreakLeader(result.data));
    }
    this._scheduleNext();
  }

  _scheduleNext() {
    if (this.dwellTimer) clearTimeout(this.dwellTimer);
    if (!this.rotation || this.sleeping) return;
    this.dwellTimer = setTimeout(async () => {
      this.rotation.advance(() => false);
      await this._mountCurrent();
    }, this.rotation.nextDwellMs());
  }

  _openSSE() {
    if (this.sleeping) return;
    try {
      this.es = new EventSource('/api/wall/events');
      this.es.addEventListener('refresh', () => this._onSseRefresh());
      this.es.onerror = () => {
        try { this.es.close(); } catch {}
        this.es = null;
        setTimeout(() => this._openSSE(), this.sseBackoffMs);
        this.sseBackoffMs = Math.min(this.sseBackoffMs * 2, 5 * 60_000);
      };
      this.es.onopen = () => { this.sseBackoffMs = 1000; };
    } catch {
      setTimeout(() => this._openSSE(), 5000);
    }
  }

  async _onSseRefresh() {
    if (this.sleeping) return;
    if (!this.activePanel || this.activePanel.key !== 'chores') return;
    try {
      const result = await this.activePanel.fetch();
      if (result?.skip || !result?.data) return;
      this.activeData = result.data;
      this.activePanel.refresh?.(result.data);
      if (this.activePanel.extractStreakLeader) {
        this.header.setStreakLeader(this.activePanel.extractStreakLeader(result.data));
      }
    } catch { /* ignore */ }
  }

  _checkSleep() {
    const inSleep = isInSleepWindow(nowHHMM(), this.config.sleep_start, this.config.sleep_end);
    if (inSleep && !this.sleeping) this._enterSleep();
    else if (!inSleep && this.sleeping) this._exitSleep();
  }

  _enterSleep() {
    this.sleeping = true;
    if (this.dwellTimer) clearTimeout(this.dwellTimer);
    if (this.es) { try { this.es.close(); } catch {} this.es = null; }
    if (this.activePanel) { try { this.activePanel.unmount?.(); } catch {} }
    if (this.activePanelEl) { this.activePanelEl.remove(); this.activePanelEl = null; this.activePanel = null; }
    this.header.hide();
    this.sleepClock = new SleepClock(this.sleepEl, this.config.sleep_clock_style);
    this.sleepClock.mount();
  }

  async _exitSleep() {
    this.sleeping = false;
    if (this.sleepClock) { this.sleepClock.unmount(); this.sleepClock = null; }
    this.header.show();
    this.rotation.setEnabled(this._enabledPanels()); // reset to chores
    await this._mountCurrent();
    this._openSSE();
  }
}
```

- [ ] **Step 2: Rewrite the wall page bootstrap**

Replace `public/js/pages/wall.js` entirely with:

```js
// Wall Suite bootstrap. Wires up the stage with header + sleep overlay.
// The heavy lifting lives in /js/wall/stage.js.
import { Stage } from '/js/wall/stage.js';

const stage = new Stage({
  stageEl:  document.getElementById('wall-stage'),
  headerEl: document.getElementById('wall-header'),
  sleepEl:  document.getElementById('wall-sleep'),
});
stage.start().catch(err => {
  // Fall back to a plain message so the wall never goes fully blank on bootstrap error.
  document.body.innerHTML = `<pre style="color:#888;font:14px monospace;padding:24px">Wall failed to start: ${err.message}</pre>`;
});
```

- [ ] **Step 3: Sanity-load it locally to catch import or runtime issues**

```bash
cd ~/projects/tally && pm2 restart tally && sleep 2 && curl -sf https://tally.thelopezfamily.org/wall | head -25
```
Expected: returns the HTML skeleton with `/js/pages/wall.js` script tag. No 500.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add public/js/wall/stage.js public/js/pages/wall.js && git commit -m "feat(wall): stage orchestrator + thin bootstrap; replaces single-panel wall.js"
```

---

## Task 13: Settings admin UI for the Wall Suite

**Files:**
- Modify: `public/js/pages/admin.js`

- [ ] **Step 1: Read the existing renderSettings to find the insertion point**

```bash
cd ~/projects/tally && grep -n "function renderSettings\|host.appendChild(retentionField)" public/js/pages/admin.js
```

The Wall Suite card group should append AFTER the photo retention field (currently the last setting block in `renderSettings`).

- [ ] **Step 2: Append the Wall Suite UI block**

In `public/js/pages/admin.js`, just before the closing `}` of `renderSettings`, add:

```js
  // ───── Wall Suite ─────
  host.appendChild(el('h3', { style: { marginTop: 'var(--s5)', marginBottom: 'var(--s3)' } }, ['Wall Suite']));

  // Panels enabled
  const enabledRaw = (s.wall_enabled_panels || 'chores,weather,calendar,verse-fact').split(',').map(p => p.trim());
  const enabledSet = new Set(enabledRaw);
  const panelOpts = [
    { k: 'chores',     label: 'Chores wall', locked: true },
    { k: 'weather',    label: 'Weather', locked: false },
    { k: 'calendar',   label: 'Calendar (Phase 2)', locked: false },
    { k: 'verse-fact', label: 'Verse / Fact (Phase 2)', locked: false },
  ];
  const panelChecks = panelOpts.map(p => {
    const cb = el('input', {
      type: 'checkbox',
      checked: enabledSet.has(p.k) || p.locked ? 'checked' : null,
      disabled: p.locked ? 'disabled' : null,
      onChange: async (e) => {
        if (e.target.checked) enabledSet.add(p.k); else enabledSet.delete(p.k);
        enabledSet.add('chores');
        const value = [...enabledSet].join(',');
        try {
          await api.patch('/api/admin/settings/wall_enabled_panels', { value });
          e.target.style.outline = '2px solid var(--green)';
          setTimeout(() => { e.target.style.outline = ''; }, 800);
        } catch (err) { alert('Save failed: ' + err.message); e.target.checked = !e.target.checked; }
      },
    });
    return el('label', { class: 'row', style: { gap: '6px', marginRight: '18px', cursor: p.locked ? 'not-allowed' : 'pointer' } }, [cb, p.label]);
  });
  host.appendChild(el('div', { class: 'form-field' }, [
    el('label', {}, ['Panels enabled']),
    el('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px' } }, panelChecks),
  ]));

  // Rotation timing
  const numField = (key, defaultVal, label, hint, min = 5, max = 600) => el('div', { class: 'form-field' }, [
    el('label', {}, [label]),
    el('input', {
      type: 'number',
      min: String(min), max: String(max),
      value: s[key] || defaultVal,
      onChange: async (e) => {
        const value = e.target.value;
        try {
          await api.patch(`/api/admin/settings/${key}`, { value: String(value) });
          e.target.style.borderColor = 'var(--green)';
          setTimeout(() => { e.target.style.borderColor = ''; }, 800);
        } catch (err) { alert('Save failed: ' + err.message); }
      },
    }),
    el('div', { class: 'muted', style: { fontSize: '0.78rem', marginTop: '4px' } }, [hint]),
  ]);
  host.appendChild(numField('wall_chores_dwell_sec', '60', 'Chores panel dwell (seconds)',
    'How long the chores wall stays before another panel visits. 5..600.'));
  host.appendChild(numField('wall_other_dwell_sec', '15', 'Other panel dwell (seconds)',
    'How long each non-chores panel shows before returning to chores. 5..600.'));

  // Weather location
  const textField = (key, defaultVal, label, hint, placeholder = '') => el('div', { class: 'form-field' }, [
    el('label', {}, [label]),
    el('input', {
      type: 'text',
      value: s[key] || defaultVal || '',
      placeholder,
      onChange: async (e) => {
        const value = e.target.value.trim();
        try {
          await api.patch(`/api/admin/settings/${key}`, { value });
          e.target.style.borderColor = 'var(--green)';
          setTimeout(() => { e.target.style.borderColor = ''; }, 800);
        } catch (err) { alert('Save failed: ' + err.message); }
      },
    }),
    el('div', { class: 'muted', style: { fontSize: '0.78rem', marginTop: '4px' } }, [hint]),
  ]);
  host.appendChild(textField('wall_weather_lat', '', 'Weather latitude',
    'Decimal degrees. Leave blank to disable weather. Example: 30.5083 for Hutto, TX.', '30.5083'));
  host.appendChild(textField('wall_weather_lon', '', 'Weather longitude',
    'Decimal degrees. Negative for western hemisphere. Example: -97.5469 for Hutto, TX.', '-97.5469'));

  const unitField = el('div', { class: 'form-field' }, [
    el('label', {}, ['Weather unit']),
    el('select', {
      onChange: async (e) => {
        try {
          await api.patch('/api/admin/settings/wall_weather_unit', { value: e.target.value });
        } catch (err) { alert('Save failed: ' + err.message); }
      },
    }, ['F','C'].map(u => el('option', { value: u, selected: (s.wall_weather_unit || 'F') === u }, [u]))),
  ]);
  host.appendChild(unitField);

  // Test button for weather
  const weatherTestBtn = el('button', {
    class: 'btn btn-ghost',
    style: { marginTop: '4px' },
    onClick: async () => {
      try {
        const r = await api.get('/api/wall/weather');
        alert(r.skip ? `Weather skipped: ${r.reason}` : `OK: ${r.current_temp}${r.unit === 'C' ? '°C' : '°F'}, theme ${r.theme}`);
      } catch (err) { alert('Test failed: ' + err.message); }
    },
  }, ['Test weather fetch']);
  host.appendChild(el('div', { class: 'form-field' }, [weatherTestBtn]));

  // Sleep window
  const timeField = (key, defaultVal, label, hint) => el('div', { class: 'form-field' }, [
    el('label', {}, [label]),
    el('input', {
      type: 'time',
      value: s[key] || defaultVal,
      onChange: async (e) => {
        try {
          await api.patch(`/api/admin/settings/${key}`, { value: e.target.value });
          e.target.style.borderColor = 'var(--green)';
          setTimeout(() => { e.target.style.borderColor = ''; }, 800);
        } catch (err) { alert('Save failed: ' + err.message); }
      },
    }),
    el('div', { class: 'muted', style: { fontSize: '0.78rem', marginTop: '4px' } }, [hint]),
  ]);
  host.appendChild(timeField('wall_sleep_start', '22:00', 'Wall sleep start',
    'When the wall enters sleep mode (black with a drifting dim clock).'));
  host.appendChild(timeField('wall_sleep_end', '06:00', 'Wall sleep end',
    'When the wall wakes back up. Crosses midnight if start > end.'));

  // Clock style
  const clockStyleField = el('div', { class: 'form-field' }, [
    el('label', {}, ['Sleep clock style']),
    el('select', {
      onChange: async (e) => {
        try {
          await api.patch('/api/admin/settings/wall_sleep_clock_style', { value: e.target.value });
        } catch (err) { alert('Save failed: ' + err.message); }
      },
    }, [
      ['digital','Digital'], ['analog-minimal','Analog · minimal'], ['analog-classic','Analog · classic'],
    ].map(([v, label]) => el('option', { value: v, selected: (s.wall_sleep_clock_style || 'analog-minimal') === v }, [label]))),
  ]);
  host.appendChild(clockStyleField);
```

- [ ] **Step 3: Sanity-check load**

```bash
cd ~/projects/tally && node --check public/js/pages/admin.js && echo "syntax ok"
```
Expected: `syntax ok`.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/admin.js && git commit -m "feat(admin-ui): Wall Suite settings panel (panels, rotation, weather, sleep)"
```

---

## Task 14: Run the full suite, manual smoke, tag and push

- [ ] **Step 1: Run full test suite**

```bash
cd ~/projects/tally && npm test 2>&1 | tail -10
```
Expected: tests pass count ≥ previous + new tests written in this plan (roughly +29). 0 fails.

- [ ] **Step 2: Restart on PM2 and tail logs**

```bash
cd ~/projects/tally && pm2 restart tally --update-env >/dev/null && sleep 2 && curl -sf -o /dev/null -w "wall http=%{http_code}\n" https://tally.thelopezfamily.org/wall && pm2 logs tally --err --lines 20 --nostream 2>&1 | tail -25
```
Expected: `wall http=200`, no new errors in the stderr tail.

- [ ] **Step 3: Manual smoke test (record in commit message what you saw)**

Open `https://tally.thelopezfamily.org/wall` in a browser and verify:
- Persistent header shows current time + today's date.
- Chores panel renders kids and "X% done today".
- After 60s (or whatever `wall_chores_dwell_sec` is), the panel cross-fades to weather (if location is set in Settings) or stays on chores (if not).
- Open Settings -> Wall Suite, set lat/lon to `30.5083`/`-97.5469`, click "Test weather fetch". An alert shows current temp and theme.
- Set `wall_sleep_start` to two minutes from now and `wall_sleep_end` to three minutes from now. Wait. The wall should go black with a drifting dim clock. After the second boundary, it should wake back into chores.

If anything in the smoke fails, STOP and fix before tagging.

- [ ] **Step 4: Tag and push**

```bash
cd ~/projects/tally && git tag -a v0.12.0-wall-suite-1 -m "$(cat <<'EOF'
v0.12.0 - Wall Suite Phase 1

Multi-panel rotating wall for the Raspberry Pi display.

- Stage orchestrator with chores-home-base smart cycle (chores 60s -> other 15s -> ...)
- Persistent header (clock + date + streak leader)
- Chores panel ported behind the panel interface (no behavior change)
- Weather panel with 8 WMO-driven CSS themes (clear-day/night, partly-cloudy,
  overcast, fog, rain, snow, thunderstorm) and pure-CSS background animations
- Open-Meteo client with 10-min cache and 30-min stale-skip rule
- Configurable overnight sleep mode with three drifting dim clock styles
  (digital, analog-minimal, analog-classic)
- Admin Settings tab gets a Wall Suite card group covering all of the above
- 9 new whitelisted settings keys with validators
- 29 new tests; full suite green
EOF
)" && git push origin master --tags 2>&1 | tail -5
```

- [ ] **Step 5: Verify push**

```bash
cd ~/projects/tally && git log --oneline -5 && git tag | tail -3
```
Expected: HEAD is the Task-13 commit, latest tag is `v0.12.0-wall-suite-1`.

---

## Self-review checklist (filled in at plan-writing time, not by the implementer)

- [x] Each spec section maps to a task.
- [x] No `TBD`/`TODO`; every step has the code or command it needs.
- [x] Function names consistent across tasks: `Rotation`, `Header`, `SleepClock`, `Stage`, `isInSleepWindow`, `mapWmoToTheme`, `parseForecast`, `fetchOpenMeteo`, `_resetWeatherState`.
- [x] Migration number 012 is one past 011.
- [x] Validator block sits after `payout_day` check, matches the existing settings PATCH style.
- [x] Smart-cycle rule encoded in `Rotation.advance()`; tests cover the 4-panel walk pattern from the spec.
- [x] Sleep wrap test covers 22:00..06:00 case from the spec.
- [x] Weather skip rule covers "no location" and "fetch failed with no cache" — the 30-min-with-stale-cache case is covered by the `stale: true` flag returned to the client.
- [x] Confetti preserved (chores panel uses existing `confetti.js`).
- [x] SSE reconnect with exponential backoff (cap 5min) implemented in `Stage._openSSE`.
