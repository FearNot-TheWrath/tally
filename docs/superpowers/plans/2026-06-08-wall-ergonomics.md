# Wall Ergonomics Implementation Plan (v0.14.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift wall settings into a dedicated admin tab, replace single `other_dwell_sec` with per-panel dwell, add a smart-cycle on/off toggle, accept a zip code (or city) instead of raw lat/lon.

**Architecture:** Migration 015 adds new settings keys with defaults derived from the old `wall_other_dwell_sec`. New `src/lib/wall/geocode.js` resolves zip/city to lat/lon via Open-Meteo's free geocoding endpoint, called from the settings PATCH handler. `Rotation` learns `dwellByPanel` + `smartCycle`. A new `renderWall` function in admin.js owns the Wall tab; the Wall Suite block leaves `renderSettings`.

**Tech Stack:** Node 20 ESM, Express 5, better-sqlite3, vanilla JS, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-08-wall-ergonomics-design.md`

---

## File map

**New:**
```
src/migrations/015-wall-per-panel-dwell.sql
src/lib/wall/geocode.js
tests/lib-wall-geocode.test.js
```

**Modified:**
```
src/routes/admin/settings.js
src/routes/wall.js
public/js/wall/rotation.js
public/js/pages/wall.js
public/js/pages/admin.js
tests/lib-wall-rotation.test.js
tests/routes-admin-settings-wall.test.js
```

---

## Task 1: Migration 015 + settings whitelist + validators

**Files:**
- Create: `src/migrations/015-wall-per-panel-dwell.sql`
- Modify: `src/routes/admin/settings.js`
- Test: `tests/routes-admin-settings-wall.test.js` (append)

- [ ] **Step 1: Write the migration**

Create `src/migrations/015-wall-per-panel-dwell.sql`:

```sql
INSERT INTO settings (key, value) VALUES
  ('wall_smart_cycle',        'on'),
  ('wall_weather_dwell_sec',  COALESCE((SELECT value FROM settings WHERE key='wall_other_dwell_sec'), '15')),
  ('wall_calendar_dwell_sec', COALESCE((SELECT value FROM settings WHERE key='wall_other_dwell_sec'), '15')),
  ('wall_verse_dwell_sec',    COALESCE((SELECT value FROM settings WHERE key='wall_other_dwell_sec'), '15')),
  ('wall_weather_location',   '')
ON CONFLICT(key) DO NOTHING;
```

- [ ] **Step 2: Verify the migration**

```bash
cd ~/projects/tally && node -e "import('./src/db.js').then(async ({runMigrations}) => { const D=(await import('better-sqlite3')).default; const db=new D(':memory:'); runMigrations(db); console.log(db.prepare(\"SELECT key,value FROM settings WHERE key LIKE 'wall_%' ORDER BY key\").all()); })"
```
Expected: includes `wall_smart_cycle = 'on'`, three new `*_dwell_sec` keys, `wall_weather_location = ''`.

- [ ] **Step 3: Add whitelist + validators**

In `src/routes/admin/settings.js`, ADD to `EDITABLE_KEYS` (the existing Set):
```
'wall_smart_cycle',
'wall_weather_dwell_sec',
'wall_calendar_dwell_sec',
'wall_verse_dwell_sec',
'wall_weather_location',
```

Add validator block in the PATCH handler, after the existing `wall_*` validators:

```js
    if (key === 'wall_smart_cycle' && value !== 'on' && value !== 'off') {
      return res.status(400).json({ error: 'wall_smart_cycle must be on or off' });
    }
    if ((key === 'wall_weather_dwell_sec' || key === 'wall_calendar_dwell_sec' || key === 'wall_verse_dwell_sec')
        && !isIntInRange(value, 5, 600)) {
      return res.status(400).json({ error: `${key} must be an integer 5..600` });
    }
    // wall_weather_location: any string up to 100 chars, server resolves it on save (Task 3).
    if (key === 'wall_weather_location' && (typeof value !== 'string' || value.length > 100)) {
      return res.status(400).json({ error: 'wall_weather_location must be a string up to 100 chars' });
    }
```

- [ ] **Step 4: Append validator tests**

Append to `tests/routes-admin-settings-wall.test.js`:

```js
test('PATCH wall_smart_cycle accepts on and off, rejects others', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  assert.equal((await agent.patch('/api/admin/settings/wall_smart_cycle').send({ value: 'on' })).status, 200);
  assert.equal((await agent.patch('/api/admin/settings/wall_smart_cycle').send({ value: 'off' })).status, 200);
  assert.equal((await agent.patch('/api/admin/settings/wall_smart_cycle').send({ value: 'maybe' })).status, 400);
});

test('PATCH per-panel dwell sec accepts 5..600 only', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  for (const key of ['wall_weather_dwell_sec', 'wall_calendar_dwell_sec', 'wall_verse_dwell_sec']) {
    assert.equal((await agent.patch(`/api/admin/settings/${key}`).send({ value: '30' })).status, 200, key);
    assert.equal((await agent.patch(`/api/admin/settings/${key}`).send({ value: '4' })).status, 400, key);
    assert.equal((await agent.patch(`/api/admin/settings/${key}`).send({ value: '601' })).status, 400, key);
  }
});

test('PATCH wall_weather_location accepts empty and short strings, rejects very long', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  assert.equal((await agent.patch('/api/admin/settings/wall_weather_location').send({ value: '' })).status, 200);
  assert.equal((await agent.patch('/api/admin/settings/wall_weather_location').send({ value: '78634' })).status, 200);
  assert.equal((await agent.patch('/api/admin/settings/wall_weather_location').send({ value: 'x'.repeat(101) })).status, 400);
});
```

- [ ] **Step 5: Run tests, confirm pass**

```bash
cd ~/projects/tally && node --test tests/routes-admin-settings-wall.test.js 2>&1 | tail -6
```
Expected: previous tests + 3 new pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/tally && git add src/migrations/015-wall-per-panel-dwell.sql src/routes/admin/settings.js tests/routes-admin-settings-wall.test.js && git commit -m "feat(settings): migration 015 + whitelist for per-panel dwell + smart cycle + weather location"
```

---

## Task 2: Geocoding library

**Files:**
- Create: `src/lib/wall/geocode.js`
- Test: `tests/lib-wall-geocode.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/lib-wall-geocode.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geocodeLocation, _classifyInput } from '../src/lib/wall/geocode.js';

test('_classifyInput recognizes zip codes', () => {
  assert.equal(_classifyInput('78634').kind, 'zip');
  assert.equal(_classifyInput(' 90210 ').kind, 'zip');
  assert.notEqual(_classifyInput('786').kind, 'zip');
});

test('_classifyInput recognizes lat,lon pairs', () => {
  const a = _classifyInput('30.5083, -97.5469');
  assert.equal(a.kind, 'latlon');
  assert.equal(a.lat, 30.5083);
  assert.equal(a.lon, -97.5469);
});

test('_classifyInput falls back to free-text', () => {
  assert.equal(_classifyInput('Hutto, TX').kind, 'text');
});

test('geocodeLocation: lat,lon path skips the API and returns parsed values', async () => {
  const r = await geocodeLocation('30.5083, -97.5469');
  assert.equal(r.lat, 30.5083);
  assert.equal(r.lon, -97.5469);
});

test('geocodeLocation: zip path calls Open-Meteo geocoding (mocked fetch)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /postal_code=78634/);
    return { ok: true, status: 200, json: async () => ({
      results: [{ latitude: 30.5083, longitude: -97.5469, name: 'Hutto' }],
    }) };
  };
  try {
    const r = await geocodeLocation('78634');
    assert.equal(r.lat, 30.5083);
    assert.equal(r.lon, -97.5469);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('geocodeLocation: city path calls Open-Meteo geocoding (mocked fetch)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /name=/);
    return { ok: true, status: 200, json: async () => ({
      results: [{ latitude: 35.0, longitude: -106.6, name: 'Albuquerque' }],
    }) };
  };
  try {
    const r = await geocodeLocation('Albuquerque, NM');
    assert.equal(r.lat, 35.0);
    assert.equal(r.lon, -106.6);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('geocodeLocation: no results returns null', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  try {
    const r = await geocodeLocation('Atlantis');
    assert.equal(r, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('geocodeLocation: fetch error returns null', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const r = await geocodeLocation('78634');
    assert.equal(r, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('geocodeLocation: empty input returns null without calling fetch', async () => {
  let called = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    const r = await geocodeLocation('');
    assert.equal(r, null);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Run failing tests**

```bash
cd ~/projects/tally && node --test tests/lib-wall-geocode.test.js 2>&1 | tail -5
```
Expected: FAIL (module not found).

- [ ] **Step 3: Implement geocode.js**

Create `src/lib/wall/geocode.js`:

```js
// Resolve a freeform location (zip, "lat,lon", or city/place) into { lat, lon }.
// Uses Open-Meteo's free geocoding API. Returns null on any failure so the
// caller can fall back to "no location configured".

const ZIP_RE   = /^\s*([0-9]{5})\s*$/;
const LATLON_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

export function _classifyInput(s) {
  if (typeof s !== 'string') return { kind: 'empty' };
  const t = s.trim();
  if (!t) return { kind: 'empty' };
  const zip = t.match(ZIP_RE);
  if (zip) return { kind: 'zip', zip: zip[1] };
  const ll = t.match(LATLON_RE);
  if (ll) return { kind: 'latlon', lat: Number(ll[1]), lon: Number(ll[2]) };
  return { kind: 'text', text: t };
}

async function callOpenMeteo(params) {
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set('count', '1');
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`geocode ${r.status}`);
  const json = await r.json();
  const hit = json?.results?.[0];
  if (!hit || typeof hit.latitude !== 'number' || typeof hit.longitude !== 'number') return null;
  return { lat: hit.latitude, lon: hit.longitude, name: hit.name || null };
}

export async function geocodeLocation(input) {
  const c = _classifyInput(input);
  if (c.kind === 'empty') return null;
  if (c.kind === 'latlon') return { lat: c.lat, lon: c.lon, name: null };
  try {
    if (c.kind === 'zip')  return await callOpenMeteo({ postal_code: c.zip, country: 'US' });
    if (c.kind === 'text') return await callOpenMeteo({ name: c.text });
  } catch (e) {
    return null;
  }
  return null;
}
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd ~/projects/tally && node --test tests/lib-wall-geocode.test.js 2>&1 | tail -5
```
Expected: 9 passing.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/lib/wall/geocode.js tests/lib-wall-geocode.test.js && git commit -m "feat(wall): geocode lib for zip/city/lat-lon location strings via Open-Meteo"
```

---

## Task 3: Wire geocoding into settings PATCH for wall_weather_location

**Files:**
- Modify: `src/routes/admin/settings.js`
- Test: `tests/routes-admin-settings-wall.test.js` (append)

- [ ] **Step 1: Add the import and a post-PATCH hook**

In `src/routes/admin/settings.js`, add import at top:

```js
import { geocodeLocation } from '../../lib/wall/geocode.js';
```

In the PATCH handler, AFTER the existing INSERT-INTO-settings (`ON CONFLICT(key) DO UPDATE SET value = excluded.value`) and BEFORE `res.json(...)`, add:

```js
    // Special handling: when the user PATCHes wall_weather_location, also
    // resolve it to lat/lon and write the resolved values into the canonical
    // wall_weather_lat / wall_weather_lon keys.
    if (key === 'wall_weather_location') {
      const resolved = await geocodeLocation(value);
      const lat = resolved ? String(resolved.lat) : '';
      const lon = resolved ? String(resolved.lon) : '';
      db.prepare(`
        INSERT INTO settings (key, value) VALUES ('wall_weather_lat', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(lat);
      db.prepare(`
        INSERT INTO settings (key, value) VALUES ('wall_weather_lon', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(lon);
      return res.json({ setting: { key, value }, resolved: resolved
        ? { lat: resolved.lat, lon: resolved.lon, name: resolved.name }
        : null });
    }
```

Important: the PATCH handler is currently synchronous. Make the handler `async`:

```js
  r.patch('/settings/:key', async (req, res) => {
```

- [ ] **Step 2: Append integration test**

Append to `tests/routes-admin-settings-wall.test.js`:

```js
test('PATCH wall_weather_location with a zip code geocodes and writes lat/lon', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /postal_code=78634/);
    return { ok: true, status: 200, json: async () => ({
      results: [{ latitude: 30.5083, longitude: -97.5469, name: 'Hutto' }],
    }) };
  };
  try {
    const r = await agent.patch('/api/admin/settings/wall_weather_location').send({ value: '78634' });
    assert.equal(r.status, 200);
    assert.equal(r.body.resolved.lat, 30.5083);
    assert.equal(r.body.resolved.lon, -97.5469);
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='wall_weather_lat'").get().value, '30.5083');
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='wall_weather_lon'").get().value, '-97.5469');
  } finally {
    globalThis.fetch = original;
  }
});

test('PATCH wall_weather_location with empty string clears lat/lon', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  db.prepare("UPDATE settings SET value='30.5' WHERE key='wall_weather_lat'").run();
  db.prepare("UPDATE settings SET value='-97.5' WHERE key='wall_weather_lon'").run();
  const r = await agent.patch('/api/admin/settings/wall_weather_location').send({ value: '' });
  assert.equal(r.status, 200);
  assert.equal(r.body.resolved, null);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='wall_weather_lat'").get().value, '');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='wall_weather_lon'").get().value, '');
});
```

- [ ] **Step 3: Run tests**

```bash
cd ~/projects/tally && node --test tests/routes-admin-settings-wall.test.js 2>&1 | tail -6
```
Expected: previous + 2 new pass.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add src/routes/admin/settings.js tests/routes-admin-settings-wall.test.js && git commit -m "feat(settings): PATCH wall_weather_location auto-resolves to lat/lon via geocode"
```

---

## Task 4: Rotation library: per-panel dwell + smartCycle option

**Files:**
- Modify: `public/js/wall/rotation.js`
- Test: `tests/lib-wall-rotation.test.js` (extend)

- [ ] **Step 1: Append failing tests**

Append to `tests/lib-wall-rotation.test.js`:

```js
test('Rotation honors per-panel dwellByPanel for nextDwellMs', () => {
  const r = new Rotation(['chores', 'weather', 'calendar'], {
    dwellByPanel: { chores: 50, weather: 25, calendar: 12 },
    smartCycle: true,
  });
  assert.equal(r.nextDwellMs(), 50_000);     // on chores
  r.advance(() => false);                    // -> weather
  assert.equal(r.nextDwellMs(), 25_000);
  r.advance(() => false);                    // -> chores (smart cycle)
  assert.equal(r.nextDwellMs(), 50_000);
  r.advance(() => false);                    // -> calendar (smart cycle)
  assert.equal(r.nextDwellMs(), 12_000);
});

test('Rotation with smartCycle off walks panels in declared order', () => {
  const r = new Rotation(['chores', 'weather', 'calendar', 'verse-fact'], {
    dwellByPanel: { chores: 10, weather: 10, calendar: 10, 'verse-fact': 10 },
    smartCycle: false,
  });
  const visited = [];
  for (let i = 0; i < 8; i++) { visited.push(r.current()); r.advance(() => false); }
  assert.deepEqual(visited, [
    'chores', 'weather', 'calendar', 'verse-fact',
    'chores', 'weather', 'calendar', 'verse-fact',
  ]);
});

test('Rotation: missing dwell entry falls back to 15s default', () => {
  const r = new Rotation(['chores', 'weather'], {
    dwellByPanel: { chores: 60 },
    smartCycle: true,
  });
  r.advance(() => false);  // -> weather
  assert.equal(r.nextDwellMs(), 15_000);
});

test('Rotation: legacy constructor options still work (choresDwellSec/otherDwellSec)', () => {
  const r = new Rotation(['chores', 'weather'], {
    choresDwellSec: 60,
    otherDwellSec:  20,
  });
  assert.equal(r.nextDwellMs(), 60_000);
  r.advance(() => false);
  assert.equal(r.nextDwellMs(), 20_000);
});
```

- [ ] **Step 2: Update Rotation class**

In `public/js/wall/rotation.js`, replace the constructor and `nextDwellMs` / `advance` per the spec. Read the current file first to know which existing options to preserve:

```bash
cd ~/projects/tally && cat public/js/wall/rotation.js
```

Modify the class to:

```js
export class Rotation {
  constructor(enabled, opts = {}) {
    // New options:
    //   dwellByPanel: { chores: number, weather: number, ... }  // seconds
    //   smartCycle:   boolean (default true)
    // Legacy options (kept for backwards compat with existing wall.js):
    //   choresDwellSec, otherDwellSec
    this._dwellByPanel = { ...(opts.dwellByPanel || {}) };
    if (opts.choresDwellSec != null && this._dwellByPanel.chores == null) {
      this._dwellByPanel.chores = opts.choresDwellSec;
    }
    this._defaultDwellSec = opts.otherDwellSec != null ? opts.otherDwellSec : 15;
    this._smartCycle = opts.smartCycle !== false;  // default true
    this.setEnabled(enabled);
  }

  setEnabled(enabled) {
    this._enabled = enabled.slice();
    this._others = this._enabled.filter(p => p !== 'chores');
    this._otherIdx = 0;
    this._flatIdx  = 0;
    this._current = this._enabled[0] || 'chores';
  }

  current() { return this._current; }

  nextDwellMs() {
    const sec = this._dwellByPanel[this._current];
    return (sec != null ? sec : this._defaultDwellSec) * 1000;
  }

  advance(shouldSkip) {
    if (!this._smartCycle) {
      // Flat rotation: walk enabled list in order, honoring skip.
      const MAX = 16;
      for (let i = 0; i < MAX; i++) {
        this._flatIdx = (this._flatIdx + 1) % this._enabled.length;
        const candidate = this._enabled[this._flatIdx];
        if (!shouldSkip(candidate)) {
          this._current = candidate;
          return;
        }
      }
      return;
    }
    // Smart cycle (existing behavior):
    if (this._others.length === 0) return;
    if (this._current !== 'chores') {
      this._current = 'chores';
      return;
    }
    const MAX = 16;
    for (let i = 0; i < MAX; i++) {
      const candidate = this._others[this._otherIdx % this._others.length];
      this._otherIdx = (this._otherIdx + 1) % this._others.length;
      if (!shouldSkip(candidate)) {
        this._current = candidate;
        return;
      }
    }
    this._current = 'chores';
  }
}
```

Verify existing tests still pass.

- [ ] **Step 3: Run tests**

```bash
cd ~/projects/tally && node --test tests/lib-wall-rotation.test.js 2>&1 | tail -5
```
Expected: all previous + 4 new pass.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add public/js/wall/rotation.js tests/lib-wall-rotation.test.js && git commit -m "feat(wall): Rotation supports dwellByPanel + smartCycle off"
```

---

## Task 5: Wall.js consumes new config + /api/wall/config exposes new fields

**Files:**
- Modify: `src/routes/wall.js`
- Modify: `public/js/pages/wall.js`

- [ ] **Step 1: Update /api/wall/config to return the new fields**

In `src/routes/wall.js`, find the `/wall/config` handler and update its response to include:

```js
      smart_cycle:           (s.wall_smart_cycle || 'on') === 'on',
      chores_dwell_sec:      Number(s.wall_chores_dwell_sec || 60),
      weather_dwell_sec:     Number(s.wall_weather_dwell_sec || 15),
      calendar_dwell_sec:    Number(s.wall_calendar_dwell_sec || 15),
      verse_dwell_sec:       Number(s.wall_verse_dwell_sec || 15),
      weather_location:      s.wall_weather_location || '',
```

Keep `other_dwell_sec` in the response for backwards compat (read from the old key) but the wall will stop using it. Also keep weather_lat/weather_lon/weather_unit, sleep_*, etc., unchanged.

- [ ] **Step 2: Update wall.js loadConfig to use per-panel dwell**

In `public/js/pages/wall.js`, find `loadConfig`. Update it to read the new fields and build a `dwellByPanel` map:

```js
  cfg.smart_cycle     = data.smart_cycle !== false;
  const dwellByPanel = {
    'chores':     Number(data.chores_dwell_sec   || 60),
    'weather':    Number(data.weather_dwell_sec  || 15),
    'calendar':   Number(data.calendar_dwell_sec || 15),
    'verse-fact': Number(data.verse_dwell_sec    || 15),
    'verse':      Number(data.verse_dwell_sec    || 15), // alias if older code used 'verse'
  };
  cfg.dwell_by_panel = dwellByPanel;

  rotation = new Rotation(cfg.enabled_panels, {
    dwellByPanel,
    smartCycle: cfg.smart_cycle,
  });
```

Remove or ignore `cfg.chores_dwell_sec` and `cfg.other_dwell_sec` references — they're superseded by the map.

- [ ] **Step 3: Syntax check + restart + smoke**

```bash
cd ~/projects/tally && node --check public/js/pages/wall.js && pm2 restart tally --update-env >/dev/null && sleep 1 && curl -sf -o /dev/null -w "wall=%{http_code} cfg=" https://tally.thelopezfamily.org/wall && curl -sf -o /dev/null -w "%{http_code}\n" https://tally.thelopezfamily.org/api/wall/config && npm test 2>&1 | tail -5
```
Expected: ok, 200, 200, 0 fails.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add src/routes/wall.js public/js/pages/wall.js && git commit -m "feat(wall): /api/wall/config exposes per-panel dwell + smart_cycle; wall.js consumes both"
```

---

## Task 6: New Wall admin tab + remove Wall Suite block from Settings

**Files:**
- Modify: `public/js/pages/admin.js`

This is the largest task. Do not skim — read the file's relevant sections first.

- [ ] **Step 1: Read the existing TABS array and renderSettings Wall Suite block**

```bash
cd ~/projects/tally && grep -n "TABS\|renderWall\|renderSettings\|Wall Suite" public/js/pages/admin.js | head -20
```

- [ ] **Step 2: Add Wall tab entry**

In the `TABS` array (top of admin.js), add an entry BEFORE `'bank'`:

```js
  { key: 'wall', label: 'Wall', render: renderWall },
```

The TABS array becomes:
```
Today, Day review, Approvals, Bonus board, Wall, Bank, People, Chores, Settings
```

- [ ] **Step 3: Implement renderWall**

Add a new function `renderWall` somewhere logical (e.g. just before `renderSettings`). It must build four cards (Panels, Rotation, Weather, Sleep) and PATCH the relevant settings keys live.

```js
async function renderWall(host) {
  clear(host);
  const data = await api.get('/api/admin/settings');
  const s = data.settings;

  host.appendChild(el('h3', { style: { marginBottom: 'var(--s4)' } }, ['Wall']));

  // ------- Card 1: Panels -------
  const enabledRaw = (s.wall_enabled_panels || 'chores,weather,calendar,verse-fact').split(',').map(p => p.trim());
  const enabledSet = new Set(enabledRaw);
  const PANELS = [
    { k: 'chores',     label: 'Chores wall',         locked: true },
    { k: 'weather',    label: 'Weather',             locked: false },
    { k: 'calendar',   label: 'Calendar (v0.15.0)',  locked: false },
    { k: 'verse-fact', label: 'Verse / Fact',        locked: false },
  ];

  const panelsCard = el('div', { class: 'card', style: { marginBottom: 'var(--s4)' } }, [
    el('h4', { style: { marginBottom: 'var(--s3)' } }, ['Panels']),
    el('div', { class: 'row', style: { flexWrap: 'wrap', gap: '12px' } },
      PANELS.map(p => {
        const cb = el('input', {
          type: 'checkbox',
          checked: (enabledSet.has(p.k) || p.locked) ? 'checked' : null,
          disabled: p.locked ? 'disabled' : null,
          onChange: async (e) => {
            if (e.target.checked) enabledSet.add(p.k); else enabledSet.delete(p.k);
            enabledSet.add('chores');
            try { await api.patch('/api/admin/settings/wall_enabled_panels', { value: [...enabledSet].join(',') }); renderWall(host); }
            catch (err) { alert('Save failed: ' + err.message); e.target.checked = !e.target.checked; }
          },
        });
        return el('label', { class: 'row', style: { gap: '6px', cursor: p.locked ? 'not-allowed' : 'pointer' } }, [cb, p.label]);
      })
    ),
    el('div', { class: 'form-field', style: { marginTop: 'var(--s3)' } }, [
      el('label', { class: 'row', style: { gap: '6px', cursor: 'pointer' } }, [
        el('input', {
          type: 'checkbox',
          checked: (s.wall_smart_cycle || 'on') === 'on' ? 'checked' : null,
          onChange: async (e) => {
            const value = e.target.checked ? 'on' : 'off';
            try { await api.patch('/api/admin/settings/wall_smart_cycle', { value }); }
            catch (err) { alert('Save failed: ' + err.message); e.target.checked = !e.target.checked; }
          },
        }),
        el('span', {}, ['Smart cycle (chores between each other panel)']),
      ]),
    ]),
  ]);
  host.appendChild(panelsCard);

  // ------- Card 2: Rotation timing -------
  const dwellState = {
    chores:     Number(s.wall_chores_dwell_sec   || 60),
    weather:    Number(s.wall_weather_dwell_sec  || 15),
    calendar:   Number(s.wall_calendar_dwell_sec || 15),
    'verse-fact': Number(s.wall_verse_dwell_sec  || 15),
  };
  function pctBadge(k) {
    const enabled = PANELS.filter(p => enabledSet.has(p.k) || p.locked).map(p => p.k);
    let total = 0;
    for (const e of enabled) total += dwellState[e] || 0;
    if (!total) return '0%';
    const v = dwellState[k] || 0;
    return Math.round((v / total) * 100) + '% of cycle';
  }
  const rotationRows = [];
  const rotationCard = el('div', { class: 'card', style: { marginBottom: 'var(--s4)' } }, [
    el('h4', { style: { marginBottom: 'var(--s3)' } }, ['Rotation timing']),
    ...PANELS.filter(p => enabledSet.has(p.k) || p.locked).map(p => {
      const settingKey = p.k === 'chores'     ? 'wall_chores_dwell_sec'
                       : p.k === 'weather'    ? 'wall_weather_dwell_sec'
                       : p.k === 'calendar'   ? 'wall_calendar_dwell_sec'
                       :                        'wall_verse_dwell_sec';
      const badge = el('span', { class: 'muted', style: { fontSize: '0.82rem', minWidth: '110px', textAlign: 'right' } }, [pctBadge(p.k)]);
      rotationRows.push({ panel: p.k, badge });
      return el('div', { class: 'row spaced', style: { marginBottom: '8px', alignItems: 'center' } }, [
        el('div', { style: { minWidth: '110px' } }, [p.label]),
        el('input', {
          type: 'number', min: '5', max: '600',
          value: String(dwellState[p.k]),
          style: { width: '90px' },
          onInput: (e) => {
            dwellState[p.k] = Number(e.target.value);
            for (const row of rotationRows) row.badge.textContent = pctBadge(row.panel);
          },
          onChange: async (e) => {
            const value = String(Number(e.target.value));
            try { await api.patch(`/api/admin/settings/${settingKey}`, { value }); e.target.style.borderColor = 'var(--green)'; setTimeout(() => { e.target.style.borderColor = ''; }, 800); }
            catch (err) { alert('Save failed: ' + err.message); }
          },
        }),
        el('span', { class: 'muted' }, ['sec']),
        badge,
      ]);
    }),
  ]);
  host.appendChild(rotationCard);

  // ------- Card 3: Weather -------
  const resolvedNote = el('div', { class: 'muted', style: { fontSize: '0.78rem', marginTop: '4px' } }, [
    (s.wall_weather_lat && s.wall_weather_lon)
      ? `Resolved to ${s.wall_weather_lat}, ${s.wall_weather_lon}`
      : 'Not resolved; weather panel will skip itself.',
  ]);
  const weatherCard = el('div', { class: 'card', style: { marginBottom: 'var(--s4)' } }, [
    el('h4', { style: { marginBottom: 'var(--s3)' } }, ['Weather']),
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Location (zip code, city, or lat,lon)']),
      el('input', {
        type: 'text', placeholder: '78634 or Hutto, TX',
        value: s.wall_weather_location || '',
        onChange: async (e) => {
          const value = e.target.value.trim();
          try {
            const r = await api.patch('/api/admin/settings/wall_weather_location', { value });
            resolvedNote.textContent = r.resolved
              ? `Resolved to ${r.resolved.lat}, ${r.resolved.lon}${r.resolved.name ? ' (' + r.resolved.name + ')' : ''}`
              : 'Could not resolve; weather panel will skip itself.';
            e.target.style.borderColor = 'var(--green)';
            setTimeout(() => { e.target.style.borderColor = ''; }, 800);
          } catch (err) { alert('Save failed: ' + err.message); }
        },
      }),
      resolvedNote,
    ]),
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Unit']),
      el('select', {
        onChange: async (e) => {
          try { await api.patch('/api/admin/settings/wall_weather_unit', { value: e.target.value }); }
          catch (err) { alert('Save failed: ' + err.message); }
        },
      }, ['F','C'].map(u => el('option', { value: u, selected: (s.wall_weather_unit || 'F') === u }, [u]))),
    ]),
    el('button', {
      class: 'btn btn-ghost',
      onClick: async () => {
        try {
          const r = await api.get('/api/wall/weather');
          alert(r.skip ? `Weather skipped: ${r.reason}` : `OK: ${r.current_temp}${r.unit === 'C' ? '°C' : '°F'}, theme ${r.theme}`);
        } catch (err) { alert('Test failed: ' + err.message); }
      },
    }, ['Test weather fetch']),
  ]);
  host.appendChild(weatherCard);

  // ------- Card 4: Sleep -------
  const timeField = (key, defaultVal, label) => el('div', { class: 'form-field' }, [
    el('label', {}, [label]),
    el('input', {
      type: 'time',
      value: s[key] || defaultVal,
      onChange: async (e) => {
        try { await api.patch(`/api/admin/settings/${key}`, { value: e.target.value }); e.target.style.borderColor = 'var(--green)'; setTimeout(() => { e.target.style.borderColor = ''; }, 800); }
        catch (err) { alert('Save failed: ' + err.message); }
      },
    }),
  ]);
  const sleepCard = el('div', { class: 'card' }, [
    el('h4', { style: { marginBottom: 'var(--s3)' } }, ['Sleep']),
    timeField('wall_sleep_start', '22:00', 'Wall sleep start'),
    timeField('wall_sleep_end',   '06:00', 'Wall sleep end'),
    el('div', { class: 'form-field' }, [
      el('label', {}, ['Sleep clock style']),
      el('select', {
        onChange: async (e) => {
          try { await api.patch('/api/admin/settings/wall_sleep_clock_style', { value: e.target.value }); }
          catch (err) { alert('Save failed: ' + err.message); }
        },
      }, [
        ['digital','Digital'], ['analog-minimal','Analog · minimal'], ['analog-classic','Analog · classic'],
      ].map(([v, label]) => el('option', { value: v, selected: (s.wall_sleep_clock_style || 'analog-minimal') === v }, [label]))),
    ]),
  ]);
  host.appendChild(sleepCard);
}
```

- [ ] **Step 4: Remove the Wall Suite block from renderSettings**

Find the existing Wall Suite section in `renderSettings` (it starts with a `// ───── Wall Suite ─────` comment or similar). Delete the entire block, top to bottom — Panels checkboxes, Rotation timing inputs, Weather inputs, Sleep inputs.

```bash
cd ~/projects/tally && grep -n "Wall Suite\|wall_enabled_panels\|wall_sleep_clock_style" public/js/pages/admin.js | head -10
```

Use the grep output to identify the exact lines and remove them from `renderSettings`.

- [ ] **Step 5: Syntax check**

```bash
cd ~/projects/tally && node --check public/js/pages/admin.js && echo "syntax ok"
```

- [ ] **Step 6: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/admin.js && git commit -m "feat(admin): new Wall admin tab; remove Wall Suite block from Settings tab"
```

---

## Task 7: Full suite, smoke, tag, push

- [ ] **Step 1: Run full suite**

```bash
cd ~/projects/tally && npm test 2>&1 | tail -8
```
Expected: prior count + ~18 new (3 settings + 9 geocode + 4 rotation + 2 wall_weather_location). 0 fails.

- [ ] **Step 2: Restart and smoke**

```bash
cd ~/projects/tally && pm2 restart tally --update-env >/dev/null && sleep 1 && curl -sf -o /dev/null -w "wall=%{http_code}\n" https://tally.thelopezfamily.org/wall && pm2 logs tally --err --lines 10 --nostream 2>&1 | tail -15
```
Expected: 200, no fresh errors.

- [ ] **Step 3: Tag**

```bash
cd ~/projects/tally && git tag -a v0.14.0-wall-ergonomics -m "$(cat <<'EOF'
v0.14.0 - Wall ergonomics

- New Wall admin tab; wall settings move out of the main Settings tab.
- Per-panel dwell time (chores, weather, calendar, verse-fact).
- Smart cycle on/off toggle (chores between others vs flat rotation).
- Live percentage-of-cycle badge next to each dwell input.
- Weather location accepts a zip code or city name; server resolves
  to lat/lon via Open-Meteo geocoding on save.
- Backwards compat: existing wall_other_dwell_sec value migrates into
  the three new per-panel keys; smart_cycle defaults to on so
  existing behavior is unchanged on upgrade.
EOF
)" && git push origin master --tags 2>&1 | tail -5
```

- [ ] **Step 4: Verify**

```bash
cd ~/projects/tally && git log --oneline -5 && git tag | tail -3
```

---

## Self-review checklist (controller fills in at plan-writing time)

- [x] All spec keys map to a task.
- [x] Migration 015 number is one past 014.
- [x] Geocoding lib has tests for zip, lat,lon, city, error, empty.
- [x] Rotation tests cover smart cycle off + per-panel dwell + missing-dwell default.
- [x] Wall.js consumes new config; admin.js renders new tab; settings.js whitelist updated.
- [x] No TBD/placeholder steps.
- [x] Backwards compat preserved: old keys still exist, smart_cycle defaults to current behavior.
