# Calendar Overlay Implementation Plan (v0.15.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Overlay today + tomorrow's Google Calendar events into the empty region of the weather panel. One-time Google OAuth setup, encrypted refresh-token storage, multi-calendar merge with per-calendar color dots, marquee scrolling on overflow.

**Architecture:** OAuth handled by a new `src/routes/auth/google.js` (start + callback) using cookie-session for state CSRF protection. Refresh token AES-256-GCM encrypted via `src/lib/crypto-settings.js` with a key derived from `SESSION_SECRET`. Google Calendar API v3 wrapped in `src/lib/wall/google-cal.js` (no SDK; native fetch). `/api/wall/calendar` fetches today + tomorrow events with a 5-minute cache. Weather panel grid grows a second column for the overlay; collapses to single column when empty.

**Tech Stack:** Node 20 ESM, Express 5, better-sqlite3, vanilla JS, Node's built-in `crypto` + `fetch`. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-06-08-calendar-overlay-design.md`

---

## File map

**New:**
```
src/migrations/016-calendar-overlay.sql
src/lib/crypto-settings.js
src/lib/wall/google-cal.js
src/routes/auth/google.js
tests/lib-crypto-settings.test.js
tests/lib-wall-google-cal.test.js
tests/routes-auth-google.test.js
tests/routes-wall-calendar.test.js
tests/routes-admin-calendar.test.js
```

**Modified:**
```
src/app.js                            mount /api/auth/google routes
src/routes/admin/settings.js          add wall_calendar_selected_ids + validator
src/routes/wall.js                    add /api/wall/calendar + admin calendar routes; expose calendar_connected
public/css/layouts.css                weather body grid + calendar overlay styles
public/js/pages/wall.js               weather render adds calendar column when data present
public/js/pages/admin.js              Wall tab gets Calendar card
.env.example                          GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
README.md                             Google Cloud OAuth setup walk-through
```

---

## Task 1: Migration 016 + settings whitelist + env example

**Files:**
- Create: `src/migrations/016-calendar-overlay.sql`
- Modify: `src/routes/admin/settings.js`
- Modify: `.env.example` (create if missing)

- [ ] **Step 1: Write the migration**

Create `src/migrations/016-calendar-overlay.sql`:

```sql
INSERT INTO settings (key, value) VALUES
  ('wall_calendar_oauth_refresh',  ''),
  ('wall_calendar_selected_ids',   ''),
  ('wall_calendar_list_cache',     '[]')
ON CONFLICT(key) DO NOTHING;
```

- [ ] **Step 2: Verify migration applies**

```bash
cd ~/projects/tally && node -e "import('./src/db.js').then(async ({runMigrations}) => { const D=(await import('better-sqlite3')).default; const db=new D(':memory:'); runMigrations(db); console.log(db.prepare(\"SELECT key,value FROM settings WHERE key LIKE 'wall_calendar%' ORDER BY key\").all()); })"
```
Expected: three new keys with empty/default values.

- [ ] **Step 3: Whitelist additions**

In `src/routes/admin/settings.js`, ADD ONLY ONE key to `EDITABLE_KEYS`:
```
'wall_calendar_selected_ids',
```

**Do NOT** add `wall_calendar_oauth_refresh` or `wall_calendar_list_cache` to `EDITABLE_KEYS` — those are written only by OAuth and admin endpoints, never by PATCH /settings. They are however added to `READABLE_KEYS` (the existing READABLE_KEYS does `...EDITABLE_KEYS`, so add them as additional entries):

After the `READABLE_KEYS` definition, add:
```js
READABLE_KEYS.add('wall_calendar_oauth_refresh');
READABLE_KEYS.add('wall_calendar_list_cache');
```

(Actually, since the admin Calendar UI calls `/api/admin/calendar/list` not `/api/admin/settings`, you may NOT need either in READABLE_KEYS. Leave them OUT of READABLE_KEYS so the GET /api/admin/settings response doesn't leak the encrypted refresh token.)

Add validator in the PATCH handler, after existing wall_* validators:

```js
    if (key === 'wall_calendar_selected_ids' && (typeof value !== 'string' || value.length > 4096)) {
      return res.status(400).json({ error: 'wall_calendar_selected_ids must be a string up to 4096 chars' });
    }
```

- [ ] **Step 4: Update .env.example**

Check if `.env.example` exists. If not, create it. Add (or append):

```
# Google Calendar OAuth (for the wall calendar overlay; v0.15.0)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://tally.thelopezfamily.org/api/auth/google/callback
```

- [ ] **Step 5: Append validator test**

In `tests/routes-admin-settings-wall.test.js`, append:

```js
test('PATCH wall_calendar_selected_ids accepts short strings, rejects very long', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  assert.equal((await agent.patch('/api/admin/settings/wall_calendar_selected_ids').send({ value: '' })).status, 200);
  assert.equal((await agent.patch('/api/admin/settings/wall_calendar_selected_ids').send({ value: 'a,b,c' })).status, 200);
  assert.equal((await agent.patch('/api/admin/settings/wall_calendar_selected_ids').send({ value: 'x'.repeat(4097) })).status, 400);
});

test('GET /api/admin/settings does NOT expose wall_calendar_oauth_refresh or list_cache', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  db.prepare("UPDATE settings SET value='SECRETSECRET' WHERE key='wall_calendar_oauth_refresh'").run();
  const r = await agent.get('/api/admin/settings');
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.wall_calendar_oauth_refresh, undefined);
  assert.equal(r.body.settings.wall_calendar_list_cache, undefined);
});
```

- [ ] **Step 6: Run tests, confirm pass**

```bash
cd ~/projects/tally && node --test tests/routes-admin-settings-wall.test.js 2>&1 | tail -6
```

- [ ] **Step 7: Commit**

```bash
cd ~/projects/tally && git add src/migrations/016-calendar-overlay.sql src/routes/admin/settings.js tests/routes-admin-settings-wall.test.js .env.example && git commit -m "feat(settings): migration 016 + whitelist for calendar-overlay (selected_ids only)"
```

---

## Task 2: Encryption helper for OAuth refresh token

**Files:**
- Create: `src/lib/crypto-settings.js`
- Test: `tests/lib-crypto-settings.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/lib-crypto-settings.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptForSetting, decryptFromSetting } from '../src/lib/crypto-settings.js';

const SECRET = 'a-very-long-test-secret-1234567890abcdef';

test('encryptForSetting + decryptFromSetting roundtrip', () => {
  const plain = 'refresh-token-1//abc123';
  const ct = encryptForSetting(plain, SECRET);
  assert.ok(typeof ct === 'string' && ct.length > 0);
  assert.notEqual(ct, plain);
  const round = decryptFromSetting(ct, SECRET);
  assert.equal(round, plain);
});

test('decryptFromSetting with the wrong secret returns null', () => {
  const ct = encryptForSetting('payload', SECRET);
  assert.equal(decryptFromSetting(ct, 'different-secret-xxxxxxxxxxxxxxxxxxxxxx'), null);
});

test('decryptFromSetting on tampered ciphertext returns null', () => {
  const ct = encryptForSetting('payload', SECRET);
  // Flip a byte in the middle.
  const buf = Buffer.from(ct, 'base64');
  buf[buf.length - 5] ^= 0xff;
  const tampered = buf.toString('base64');
  assert.equal(decryptFromSetting(tampered, SECRET), null);
});

test('decryptFromSetting on empty / garbage input returns null', () => {
  assert.equal(decryptFromSetting('', SECRET), null);
  assert.equal(decryptFromSetting('not-base64-!@#$', SECRET), null);
  assert.equal(decryptFromSetting('AAA=', SECRET), null);
});

test('encryptForSetting produces different ciphertext for the same plaintext (random nonce)', () => {
  const a = encryptForSetting('x', SECRET);
  const b = encryptForSetting('x', SECRET);
  assert.notEqual(a, b);
});
```

- [ ] **Step 2: Run failing tests**

```bash
cd ~/projects/tally && node --test tests/lib-crypto-settings.test.js 2>&1 | tail -5
```
Expected: FAIL (module not found).

- [ ] **Step 3: Implement crypto-settings.js**

Create `src/lib/crypto-settings.js`:

```js
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

// AES-256-GCM. 12-byte nonce, 16-byte auth tag, ciphertext.
// Stored payload (base64): [12-byte nonce][16-byte tag][ciphertext]
//
// Key derivation: scrypt(secret, fixed salt, 32 bytes). The salt is the literal
// string 'tally-wall-calendar-v1' so the same SECRET always derives the same key.

const SALT = Buffer.from('tally-wall-calendar-v1');
const KEY_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;

function deriveKey(secret) {
  return scryptSync(String(secret), SALT, KEY_LEN);
}

export function encryptForSetting(plaintext, secret) {
  const key = deriveKey(secret);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, enc]).toString('base64');
}

export function decryptFromSetting(ciphertext, secret) {
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) return null;
  let buf;
  try { buf = Buffer.from(ciphertext, 'base64'); } catch { return null; }
  if (buf.length < NONCE_LEN + TAG_LEN + 1) return null;
  const nonce = buf.subarray(0, NONCE_LEN);
  const tag   = buf.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN);
  const enc   = buf.subarray(NONCE_LEN + TAG_LEN);
  try {
    const key = deriveKey(secret);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd ~/projects/tally && node --test tests/lib-crypto-settings.test.js 2>&1 | tail -5
```
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/lib/crypto-settings.js tests/lib-crypto-settings.test.js && git commit -m "feat(crypto): AES-256-GCM encrypt/decrypt for OAuth refresh token storage"
```

---

## Task 3: Google Calendar API client

**Files:**
- Create: `src/lib/wall/google-cal.js`
- Test: `tests/lib-wall-google-cal.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/lib-wall-google-cal.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  exchangeAuthCode,
  refreshAccessToken,
  fetchCalendarList,
  fetchCalendarEvents,
  InvalidGrantError,
  _resetTokenCache,
} from '../src/lib/wall/google-cal.js';

function mockFetchWith(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

test('exchangeAuthCode happy path', async () => {
  const restore = mockFetchWith(async (url, opts) => {
    assert.match(String(url), /oauth2\.googleapis\.com\/token/);
    assert.equal(opts.method, 'POST');
    assert.match(opts.body.toString(), /grant_type=authorization_code/);
    return { ok: true, status: 200, json: async () => ({
      access_token: 'AT', refresh_token: 'RT', expires_in: 3599,
    }) };
  });
  try {
    const r = await exchangeAuthCode('code-abc', 'https://example.com/cb');
    assert.equal(r.access_token, 'AT');
    assert.equal(r.refresh_token, 'RT');
  } finally { restore(); }
});

test('exchangeAuthCode error throws', async () => {
  const restore = mockFetchWith(async () => ({ ok: false, status: 400, text: async () => '{"error":"bad"}' }));
  try {
    await assert.rejects(() => exchangeAuthCode('bad', 'https://example.com/cb'));
  } finally { restore(); }
});

test('refreshAccessToken success', async () => {
  _resetTokenCache();
  const restore = mockFetchWith(async () => ({ ok: true, status: 200, json: async () => ({
    access_token: 'AT2', expires_in: 3600,
  }) }));
  try {
    const r = await refreshAccessToken('RT');
    assert.equal(r.access_token, 'AT2');
  } finally { restore(); }
});

test('refreshAccessToken invalid_grant throws InvalidGrantError', async () => {
  _resetTokenCache();
  const restore = mockFetchWith(async () => ({ ok: false, status: 400, text: async () => '{"error":"invalid_grant"}' }));
  try {
    await assert.rejects(() => refreshAccessToken('expired'), InvalidGrantError);
  } finally { restore(); }
});

test('refreshAccessToken cache hit returns cached without refetch', async () => {
  _resetTokenCache();
  let calls = 0;
  const restore = mockFetchWith(async () => { calls++; return { ok: true, status: 200, json: async () => ({ access_token: 'CACHED', expires_in: 3600 }) }; });
  try {
    await refreshAccessToken('RT');
    await refreshAccessToken('RT');
    assert.equal(calls, 1);
  } finally { restore(); }
});

test('fetchCalendarList returns simplified items', async () => {
  const restore = mockFetchWith(async (url) => {
    assert.match(String(url), /calendarList/);
    return { ok: true, status: 200, json: async () => ({ items: [
      { id: 'a', summary: 'Family',  backgroundColor: '#FF0000', primary: true,  accessRole: 'owner' },
      { id: 'b', summary: 'Parish',  backgroundColor: '#00FF00', primary: false, accessRole: 'reader' },
    ] }) };
  });
  try {
    const list = await fetchCalendarList('AT');
    assert.equal(list.length, 2);
    assert.equal(list[0].id, 'a');
    assert.equal(list[0].primary, true);
    assert.equal(list[1].backgroundColor, '#00FF00');
  } finally { restore(); }
});

test('fetchCalendarEvents filters cancelled and returns normalized shape', async () => {
  const restore = mockFetchWith(async (url) => {
    assert.match(String(url), /calendars\/cal-1\/events/);
    return { ok: true, status: 200, json: async () => ({ items: [
      { id: 'e1', status: 'confirmed', summary: 'Soccer practice', location: 'Park', start: { dateTime: '2026-06-08T18:00:00-05:00' }, end: { dateTime: '2026-06-08T19:00:00-05:00' } },
      { id: 'e2', status: 'cancelled', summary: 'Cancelled meeting', start: { dateTime: '2026-06-08T20:00:00-05:00' }, end: { dateTime: '2026-06-08T21:00:00-05:00' } },
      { id: 'e3', status: 'confirmed', summary: 'Birthday', start: { date: '2026-06-08' }, end: { date: '2026-06-09' } },
    ] }) };
  });
  try {
    const events = await fetchCalendarEvents('AT', 'cal-1', '2026-06-08T00:00:00-05:00', '2026-06-09T23:59:59-05:00');
    assert.equal(events.length, 2);
    assert.equal(events[0].summary, 'Soccer practice');
    assert.equal(events[1].summary, 'Birthday');
    assert.equal(events[1].isAllDay, true);
    assert.equal(events[0].isAllDay, false);
  } finally { restore(); }
});
```

- [ ] **Step 2: Run failing tests**

```bash
cd ~/projects/tally && node --test tests/lib-wall-google-cal.test.js 2>&1 | tail -5
```
Expected: FAIL.

- [ ] **Step 3: Implement google-cal.js**

Create `src/lib/wall/google-cal.js`:

```js
// Google Calendar API v3 client. Uses native fetch; no SDK.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CAL_LIST_URL = 'https://www.googleapis.com/calendar/v3/users/me/calendarList';
const EVENTS_URL = (id) => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}/events`;

export class InvalidGrantError extends Error {
  constructor(msg) { super(msg || 'invalid_grant'); this.name = 'InvalidGrantError'; }
}

// In-memory access-token cache keyed by refresh token.
// Each entry: { access_token, expiresAt: epochMs }.
let tokenCache = new Map();

export function _resetTokenCache() { tokenCache = new Map(); }

function bodyFromObject(obj) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) u.append(k, String(v));
  return u.toString();
}

export async function exchangeAuthCode(code, redirectUri) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: bodyFromObject({
      code,
      client_id:     process.env.GOOGLE_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`exchangeAuthCode ${r.status}: ${t}`);
  }
  return await r.json();
}

export async function refreshAccessToken(refreshToken) {
  const cached = tokenCache.get(refreshToken);
  if (cached && cached.expiresAt > Date.now() + 30_000) {
    return { access_token: cached.access_token, expires_in: Math.round((cached.expiresAt - Date.now()) / 1000) };
  }
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: bodyFromObject({
      refresh_token: refreshToken,
      client_id:     process.env.GOOGLE_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      grant_type:    'refresh_token',
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    if (/invalid_grant/.test(t)) throw new InvalidGrantError();
    throw new Error(`refreshAccessToken ${r.status}: ${t}`);
  }
  const json = await r.json();
  tokenCache.set(refreshToken, {
    access_token: json.access_token,
    expiresAt: Date.now() + Math.max(60, (json.expires_in || 3600) - 60) * 1000,
  });
  return json;
}

export async function fetchCalendarList(accessToken) {
  const r = await fetch(CAL_LIST_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`fetchCalendarList ${r.status}`);
  const json = await r.json();
  return (json.items || []).map(c => ({
    id:              c.id,
    summary:         c.summary || c.summaryOverride || c.id,
    backgroundColor: c.backgroundColor || '#7986CB',
    primary:         !!c.primary,
    accessRole:      c.accessRole || 'reader',
  }));
}

export async function fetchCalendarEvents(accessToken, calendarId, timeMin, timeMax) {
  const u = new URL(EVENTS_URL(calendarId));
  u.searchParams.set('timeMin', timeMin);
  u.searchParams.set('timeMax', timeMax);
  u.searchParams.set('singleEvents', 'true');
  u.searchParams.set('orderBy', 'startTime');
  u.searchParams.set('maxResults', '50');
  const r = await fetch(u, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`fetchCalendarEvents ${r.status}`);
  const json = await r.json();
  return (json.items || [])
    .filter(e => e.status !== 'cancelled')
    .map(e => ({
      id:        e.id,
      summary:   e.summary || '(no title)',
      location:  e.location || '',
      isAllDay:  !!(e.start?.date),
      start:     e.start?.dateTime || e.start?.date || null,
      end:       e.end?.dateTime   || e.end?.date   || null,
    }));
}
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd ~/projects/tally && node --test tests/lib-wall-google-cal.test.js 2>&1 | tail -5
```
Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/lib/wall/google-cal.js tests/lib-wall-google-cal.test.js && git commit -m "feat(wall): Google Calendar API client (exchange/refresh/list/events) with token cache"
```

---

## Task 4: OAuth start + callback routes

**Files:**
- Create: `src/routes/auth/google.js`
- Modify: `src/app.js` (mount the new routes)
- Test: `tests/routes-auth-google.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/routes-auth-google.test.js`:

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

test('GET /api/auth/google/start redirects to Google with state + scope', async () => {
  process.env.GOOGLE_CLIENT_ID = 'cid';
  process.env.GOOGLE_REDIRECT_URI = 'https://example.com/cb';
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const r = await agent.get('/api/auth/google/start');
  assert.equal(r.status, 302);
  assert.match(r.headers.location, /accounts\.google\.com/);
  assert.match(r.headers.location, /scope=https/);
  assert.match(r.headers.location, /state=[a-f0-9]+/);
  assert.match(r.headers.location, /access_type=offline/);
  assert.match(r.headers.location, /prompt=consent/);
});

test('GET /api/auth/google/callback rejects mismatched state', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  // hit start first to set the cookie state
  await agent.get('/api/auth/google/start');
  const r = await agent.get('/api/auth/google/callback?code=c&state=WRONG');
  assert.equal(r.status, 302);
  assert.match(r.headers.location, /wall_calendar_error=state/);
});

test('GET /api/auth/google/callback exchanges code and stores encrypted refresh', async () => {
  process.env.GOOGLE_CLIENT_ID = 'cid';
  process.env.GOOGLE_CLIENT_SECRET = 'secret';
  process.env.GOOGLE_REDIRECT_URI = 'https://example.com/cb';
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const startRes = await agent.get('/api/auth/google/start');
  const state = startRes.headers.location.match(/state=([a-f0-9]+)/)[1];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (/token/.test(String(url))) return { ok: true, status: 200, json: async () => ({
      access_token: 'AT', refresh_token: 'RT', expires_in: 3600,
    }) };
    if (/calendarList/.test(String(url))) return { ok: true, status: 200, json: async () => ({ items: [
      { id: 'a', summary: 'Family', backgroundColor: '#FF0000', primary: true, accessRole: 'owner' },
    ] }) };
    throw new Error('unexpected fetch ' + url);
  };
  try {
    const r = await agent.get(`/api/auth/google/callback?code=goodcode&state=${state}`);
    assert.equal(r.status, 302);
    assert.match(r.headers.location, /admin#wall/);
    const stored = db.prepare("SELECT value FROM settings WHERE key='wall_calendar_oauth_refresh'").get().value;
    assert.ok(stored && stored.length > 0);
    assert.notEqual(stored, 'RT'); // encrypted
    const list = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='wall_calendar_list_cache'").get().value);
    assert.equal(list[0].id, 'a');
  } finally { globalThis.fetch = origFetch; }
});
```

- [ ] **Step 2: Run failing tests**

```bash
cd ~/projects/tally && node --test tests/routes-auth-google.test.js 2>&1 | tail -5
```
Expected: FAIL.

- [ ] **Step 3: Implement the routes**

Create `src/routes/auth/google.js`:

```js
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { requireRole } from '../../auth.js';
import { exchangeAuthCode, fetchCalendarList } from '../../lib/wall/google-cal.js';
import { encryptForSetting } from '../../lib/crypto-settings.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

export function googleAuthRoutes() {
  const r = Router();

  r.get('/google/start', requireRole('parent'), (req, res) => {
    const state = randomBytes(16).toString('hex');
    req.session.oauth_state = state;
    const u = new URL(AUTH_URL);
    u.searchParams.set('client_id',     process.env.GOOGLE_CLIENT_ID || '');
    u.searchParams.set('redirect_uri',  process.env.GOOGLE_REDIRECT_URI || '');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope',         SCOPE);
    u.searchParams.set('access_type',   'offline');
    u.searchParams.set('prompt',        'consent');
    u.searchParams.set('state',         state);
    res.redirect(u.toString());
  });

  r.get('/google/callback', async (req, res) => {
    const expected = req.session?.oauth_state;
    const got = req.query?.state;
    req.session.oauth_state = null;
    if (!expected || expected !== got) {
      return res.redirect('/admin?wall_calendar_error=state#wall');
    }
    const code = req.query?.code;
    if (!code) {
      return res.redirect('/admin?wall_calendar_error=nocode#wall');
    }
    try {
      const redirectUri = process.env.GOOGLE_REDIRECT_URI || '';
      const tokens = await exchangeAuthCode(code, redirectUri);
      const refresh = tokens.refresh_token;
      const access  = tokens.access_token;
      if (!refresh || !access) {
        return res.redirect('/admin?wall_calendar_error=notokens#wall');
      }
      const secret = process.env.SESSION_SECRET || 'dev-secret-change-me';
      const ct = encryptForSetting(refresh, secret);
      const db = req.app.get('db');
      db.prepare(`INSERT INTO settings (key, value) VALUES ('wall_calendar_oauth_refresh', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(ct);

      // Fetch + cache the calendar list using the just-issued access token.
      try {
        const list = await fetchCalendarList(access);
        db.prepare(`INSERT INTO settings (key, value) VALUES ('wall_calendar_list_cache', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(list));
      } catch (e) {
        // Non-fatal; user can hit "Refresh calendar list" later.
        console.error('[google/callback] calendar list fetch failed:', e.message);
      }
      return res.redirect('/admin?wall_calendar_status=connected#wall');
    } catch (e) {
      console.error('[google/callback] OAuth exchange failed:', e.message);
      return res.redirect('/admin?wall_calendar_error=exchange#wall');
    }
  });

  return r;
}
```

- [ ] **Step 4: Mount the routes in app.js**

In `src/app.js`, add the import at top:
```js
import { googleAuthRoutes } from './routes/auth/google.js';
```

In the `buildApp` function, register the routes (anywhere after `app.use('/api/auth', authRoutes())` is fine):
```js
  app.use('/api/auth', googleAuthRoutes());
```

- [ ] **Step 5: Run tests**

```bash
cd ~/projects/tally && node --test tests/routes-auth-google.test.js 2>&1 | tail -5
```
Expected: 3 passing.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/tally && git add src/routes/auth/google.js src/app.js tests/routes-auth-google.test.js && git commit -m "feat(auth): Google OAuth start + callback routes (encrypted refresh, list cache, state CSRF)"
```

---

## Task 5: Calendar fetch endpoint + admin calendar endpoints

**Files:**
- Modify: `src/routes/wall.js` (add /api/wall/calendar + admin calendar routes)
- Test: `tests/routes-wall-calendar.test.js`
- Test: `tests/routes-admin-calendar.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/routes-wall-calendar.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';
import { _resetCalendarCache } from '../src/routes/wall.js';
import { encryptForSetting } from '../src/lib/crypto-settings.js';

function setRefresh(db, plain) {
  const secret = process.env.SESSION_SECRET || 'dev-secret-change-me';
  const ct = encryptForSetting(plain, secret);
  db.prepare("UPDATE settings SET value=? WHERE key='wall_calendar_oauth_refresh'").run(ct);
}
function setSelected(db, csv) {
  db.prepare("UPDATE settings SET value=? WHERE key='wall_calendar_selected_ids'").run(csv);
}

test('GET /api/wall/calendar returns skip when not connected', async () => {
  _resetCalendarCache();
  const db = freshDb();
  const app = freshApp(db);
  const r = await request(app).get('/api/wall/calendar');
  assert.equal(r.status, 200);
  assert.equal(r.body.skip, true);
  assert.match(r.body.reason || '', /not connected/);
});

test('GET /api/wall/calendar returns skip when connected but no calendars selected', async () => {
  _resetCalendarCache();
  const db = freshDb();
  setRefresh(db, 'RT');
  const app = freshApp(db);
  const r = await request(app).get('/api/wall/calendar');
  assert.equal(r.body.skip, true);
  assert.match(r.body.reason || '', /no calendars/);
});

test('GET /api/wall/calendar returns grouped events', async () => {
  _resetCalendarCache();
  const db = freshDb();
  setRefresh(db, 'RT');
  setSelected(db, 'cal-1');
  db.prepare("UPDATE settings SET value=? WHERE key='wall_calendar_list_cache'").run(JSON.stringify([
    { id: 'cal-1', summary: 'Family', backgroundColor: '#22C55E', primary: true, accessRole: 'owner' },
  ]));
  const today = new Date().toISOString().slice(0,10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0,10);
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (/token/.test(String(url))) return { ok: true, status: 200, json: async () => ({ access_token: 'AT', expires_in: 3600 }) };
    if (/calendars\/cal-1\/events/.test(String(url))) return { ok: true, status: 200, json: async () => ({ items: [
      { id: 'e1', status: 'confirmed', summary: 'Robotics', location: 'Hutto HS', start: { dateTime: `${today}T19:00:00-05:00` }, end: { dateTime: `${today}T20:00:00-05:00` } },
      { id: 'e2', status: 'confirmed', summary: 'School day', start: { date: today }, end: { date: tomorrow } },
      { id: 'e3', status: 'confirmed', summary: 'Soccer', start: { dateTime: `${tomorrow}T17:00:00-05:00` }, end: { dateTime: `${tomorrow}T18:00:00-05:00` } },
    ] }) };
    throw new Error('unexpected ' + url);
  };
  try {
    const app = freshApp(db);
    const r = await request(app).get('/api/wall/calendar');
    assert.equal(r.status, 200);
    assert.equal(r.body.skip, undefined);
    assert.ok(Array.isArray(r.body.today.timed));
    assert.ok(Array.isArray(r.body.today.allDay));
    assert.equal(r.body.today.timed.length, 1);
    assert.equal(r.body.today.allDay.length, 1);
    assert.equal(r.body.tomorrow.timed.length, 1);
    assert.equal(r.body.today.timed[0].calendar_color, '#22C55E');
  } finally { globalThis.fetch = original; }
});

test('GET /api/wall/calendar returns skip + clears refresh on invalid_grant', async () => {
  _resetCalendarCache();
  const db = freshDb();
  setRefresh(db, 'EXPIRED');
  setSelected(db, 'cal-1');
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => '{"error":"invalid_grant"}' });
  try {
    const app = freshApp(db);
    const r = await request(app).get('/api/wall/calendar');
    assert.equal(r.body.skip, true);
    assert.match(r.body.reason || '', /reconnect/);
    const cleared = db.prepare("SELECT value FROM settings WHERE key='wall_calendar_oauth_refresh'").get().value;
    assert.equal(cleared, '');
  } finally { globalThis.fetch = original; }
});
```

Create `tests/routes-admin-calendar.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';
import { encryptForSetting } from '../src/lib/crypto-settings.js';

async function asParent(app, db) {
  const id = db.prepare("INSERT INTO people (name, role) VALUES ('Mom','parent') RETURNING id").get().id;
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id, pin: '1234' });
  return agent;
}

test('GET /api/admin/calendar/list returns cached list', async () => {
  const db = freshDb();
  db.prepare("UPDATE settings SET value=? WHERE key='wall_calendar_list_cache'").run(JSON.stringify([
    { id: 'a', summary: 'Family', backgroundColor: '#FF0000', primary: true, accessRole: 'owner' },
  ]));
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const r = await agent.get('/api/admin/calendar/list');
  assert.equal(r.status, 200);
  assert.equal(r.body.connected, false);
  assert.equal(r.body.calendars.length, 1);
});

test('GET /api/admin/calendar/list reports connected when refresh present', async () => {
  const db = freshDb();
  const secret = process.env.SESSION_SECRET || 'dev-secret-change-me';
  db.prepare("UPDATE settings SET value=? WHERE key='wall_calendar_oauth_refresh'").run(encryptForSetting('RT', secret));
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const r = await agent.get('/api/admin/calendar/list');
  assert.equal(r.body.connected, true);
});

test('POST /api/admin/calendar/disconnect clears refresh + selected + list cache', async () => {
  const db = freshDb();
  const secret = process.env.SESSION_SECRET || 'dev-secret-change-me';
  db.prepare("UPDATE settings SET value=? WHERE key='wall_calendar_oauth_refresh'").run(encryptForSetting('RT', secret));
  db.prepare("UPDATE settings SET value='a,b' WHERE key='wall_calendar_selected_ids'").run();
  db.prepare("UPDATE settings SET value='[1]' WHERE key='wall_calendar_list_cache'").run();
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const r = await agent.post('/api/admin/calendar/disconnect');
  assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='wall_calendar_oauth_refresh'").get().value, '');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='wall_calendar_selected_ids'").get().value, '');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='wall_calendar_list_cache'").get().value, '[]');
});
```

- [ ] **Step 2: Run failing tests**

```bash
cd ~/projects/tally && node --test tests/routes-wall-calendar.test.js tests/routes-admin-calendar.test.js 2>&1 | tail -5
```
Expected: FAIL.

- [ ] **Step 3: Implement the endpoints**

In `src/routes/wall.js`, at the top add imports:

```js
import { decryptFromSetting } from '../lib/crypto-settings.js';
import { refreshAccessToken, fetchCalendarList, fetchCalendarEvents, InvalidGrantError } from '../lib/wall/google-cal.js';
```

Add the calendar cache state near the existing weather cache:

```js
let calendarCache = null;        // { key, data, fetchedAt }
let calendarLastFailureLog = 0;

const CALENDAR_CACHE_MS = 5 * 60 * 1000;

export function _resetCalendarCache() {
  calendarCache = null;
  calendarLastFailureLog = 0;
}
```

Inside `wallRoutes()`, add the calendar endpoint (after the weather endpoint):

```js
  r.get('/wall/calendar', async (req, res) => {
    const db = req.app.get('db');
    const rows = db.prepare(
      "SELECT key, value FROM settings WHERE key IN ('wall_calendar_oauth_refresh','wall_calendar_selected_ids','wall_calendar_list_cache')"
    ).all();
    const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
    if (!s.wall_calendar_oauth_refresh) return res.json({ skip: true, reason: 'not connected' });
    if (!s.wall_calendar_selected_ids)  return res.json({ skip: true, reason: 'no calendars selected' });

    const ids = s.wall_calendar_selected_ids.split(',').map(x => x.trim()).filter(Boolean);
    if (ids.length === 0) return res.json({ skip: true, reason: 'no calendars selected' });

    const cacheKey = ids.join(',');
    const now = Date.now();
    if (calendarCache && calendarCache.key === cacheKey && (now - calendarCache.fetchedAt) < CALENDAR_CACHE_MS) {
      return res.json(calendarCache.data);
    }

    const secret = process.env.SESSION_SECRET || 'dev-secret-change-me';
    const refresh = decryptFromSetting(s.wall_calendar_oauth_refresh, secret);
    if (!refresh) {
      return res.json({ skip: true, reason: 'reconnect required (decrypt failed)' });
    }

    let access;
    try {
      const t = await refreshAccessToken(refresh);
      access = t.access_token;
    } catch (e) {
      if (e instanceof InvalidGrantError) {
        db.prepare("UPDATE settings SET value='' WHERE key='wall_calendar_oauth_refresh'").run();
        return res.json({ skip: true, reason: 'reconnect required' });
      }
      if (now - calendarLastFailureLog > 5 * 60 * 1000) {
        console.error('[wall/calendar] refresh failed:', e.message);
        calendarLastFailureLog = now;
      }
      return res.json({ skip: true, reason: 'fetch failed' });
    }

    const list = (() => { try { return JSON.parse(s.wall_calendar_list_cache || '[]'); } catch { return []; } })();
    const colorById = Object.fromEntries(list.map(c => [c.id, c.backgroundColor]));

    // Window: today 00:00 local through tomorrow 23:59 local.
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrowEnd = new Date(today); tomorrowEnd.setDate(tomorrowEnd.getDate() + 2); tomorrowEnd.setMilliseconds(-1);
    const timeMin = today.toISOString();
    const timeMax = tomorrowEnd.toISOString();
    const todayIso = today.toISOString().slice(0,10);
    const tomorrowIso = new Date(today.getTime() + 86400000).toISOString().slice(0,10);

    let allEvents = [];
    try {
      for (const id of ids) {
        const events = await fetchCalendarEvents(access, id, timeMin, timeMax);
        for (const e of events) {
          allEvents.push({ ...e, calendar_id: id, calendar_color: colorById[id] || '#7986CB' });
        }
      }
    } catch (e) {
      if (now - calendarLastFailureLog > 5 * 60 * 1000) {
        console.error('[wall/calendar] events fetch failed:', e.message);
        calendarLastFailureLog = now;
      }
      return res.json({ skip: true, reason: 'fetch failed' });
    }

    const dayOf = (e) => (e.start && e.start.slice(0,10)) || '';
    const todayAll  = allEvents.filter(e =>  e.isAllDay && dayOf(e) === todayIso);
    const todayTimed = allEvents.filter(e => !e.isAllDay && dayOf(e) === todayIso);
    const tomAll    = allEvents.filter(e =>  e.isAllDay && dayOf(e) === tomorrowIso);
    const tomTimed  = allEvents.filter(e => !e.isAllDay && dayOf(e) === tomorrowIso);

    const total = todayAll.length + todayTimed.length + tomAll.length + tomTimed.length;
    if (total === 0) {
      const data = { skip: true, reason: 'no events' };
      calendarCache = { key: cacheKey, data, fetchedAt: now };
      return res.json(data);
    }

    const data = {
      today:    { allDay: todayAll,  timed: todayTimed },
      tomorrow: { allDay: tomAll,    timed: tomTimed },
    };
    calendarCache = { key: cacheKey, data, fetchedAt: now };
    res.json(data);
  });
```

Add admin endpoints (mounted on the same router; they live under `/api/admin/calendar/*` via the existing `/api/admin` prefix used by other admin routes). Actually since `wallRoutes` is mounted at `/api`, admin routes belong in a different router. Mount them in `src/routes/admin/calendar.js`:

Create `src/routes/admin/calendar.js`:

```js
import { Router } from 'express';
import { requireRole } from '../../auth.js';
import { decryptFromSetting } from '../../lib/crypto-settings.js';
import { refreshAccessToken, fetchCalendarList, InvalidGrantError } from '../../lib/wall/google-cal.js';

export function adminCalendarRoutes() {
  const r = Router();
  r.use(requireRole('parent'));

  r.get('/calendar/list', (req, res) => {
    const db = req.app.get('db');
    const refresh = db.prepare("SELECT value FROM settings WHERE key='wall_calendar_oauth_refresh'").get()?.value || '';
    const listJson = db.prepare("SELECT value FROM settings WHERE key='wall_calendar_list_cache'").get()?.value || '[]';
    const selectedRaw = db.prepare("SELECT value FROM settings WHERE key='wall_calendar_selected_ids'").get()?.value || '';
    let list = [];
    try { list = JSON.parse(listJson); } catch { list = []; }
    res.json({
      connected: !!refresh,
      calendars: list,
      selected_ids: selectedRaw,
    });
  });

  r.post('/calendar/refresh-list', async (req, res) => {
    const db = req.app.get('db');
    const stored = db.prepare("SELECT value FROM settings WHERE key='wall_calendar_oauth_refresh'").get()?.value || '';
    if (!stored) return res.status(400).json({ error: 'not connected' });
    const secret = process.env.SESSION_SECRET || 'dev-secret-change-me';
    const refresh = decryptFromSetting(stored, secret);
    if (!refresh) return res.status(400).json({ error: 'decrypt failed' });
    try {
      const t = await refreshAccessToken(refresh);
      const list = await fetchCalendarList(t.access_token);
      db.prepare(`INSERT INTO settings (key, value) VALUES ('wall_calendar_list_cache', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(list));
      res.json({ calendars: list });
    } catch (e) {
      if (e instanceof InvalidGrantError) {
        db.prepare("UPDATE settings SET value='' WHERE key='wall_calendar_oauth_refresh'").run();
        return res.status(401).json({ error: 'reconnect required' });
      }
      return res.status(500).json({ error: e.message });
    }
  });

  r.post('/calendar/disconnect', (req, res) => {
    const db = req.app.get('db');
    db.prepare("UPDATE settings SET value='' WHERE key='wall_calendar_oauth_refresh'").run();
    db.prepare("UPDATE settings SET value='' WHERE key='wall_calendar_selected_ids'").run();
    db.prepare("UPDATE settings SET value='[]' WHERE key='wall_calendar_list_cache'").run();
    res.json({ ok: true });
  });

  return r;
}
```

Mount in `src/app.js`:
```js
import { adminCalendarRoutes } from './routes/admin/calendar.js';
// ...
app.use('/api/admin', adminCalendarRoutes());
```

- [ ] **Step 4: Run tests**

```bash
cd ~/projects/tally && node --test tests/routes-wall-calendar.test.js tests/routes-admin-calendar.test.js 2>&1 | tail -6
```
Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tally && git add src/routes/wall.js src/routes/admin/calendar.js src/app.js tests/routes-wall-calendar.test.js tests/routes-admin-calendar.test.js && git commit -m "feat(wall): /api/wall/calendar (5-min cache, invalid_grant clears refresh) + admin list/refresh/disconnect"
```

---

## Task 6: Weather panel grows a calendar column

**Files:**
- Modify: `public/css/layouts.css`
- Modify: `public/js/pages/wall.js`

- [ ] **Step 1: Add CSS for the two-column weather body + calendar overlay**

In `public/css/layouts.css`, find the existing `.wall-page-weather` block (added in v0.14 work). Update it (or append after it):

```css
.wall-page-weather { display: grid; grid-template-rows: auto 1fr auto; }
.wall-page-weather .wall-header { grid-row: 1; }
.wall-page-weather .weather-body { grid-row: 2; }
.wall-page-weather .weather-forecast { grid-row: 3; }

.weather-body {
  display: grid;
  grid-template-columns: 1fr;
  gap: 32px;
  align-items: center;
}
.weather-body.has-calendar {
  grid-template-columns: 1fr minmax(280px, 32%);
}

.calendar-overlay {
  align-self: stretch;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 18px;
  background: rgba(0,0,0,0.18);
  border-radius: 14px;
  max-height: 100%;
  overflow: hidden;
  position: relative;
}
.calendar-overlay .cal-day-label {
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  opacity: 0.85;
}
.calendar-overlay .cal-divider {
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  opacity: 0.75;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(255,255,255,0.15);
}
.calendar-overlay .cal-allday-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.calendar-overlay .cal-allday-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.78rem;
  padding: 2px 8px;
  background: rgba(255,255,255,0.08);
  border-left: 3px solid var(--dot, #7986CB);
  border-radius: 4px;
}
.calendar-overlay .cal-events {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.calendar-overlay .cal-event {
  display: grid;
  grid-template-columns: 62px 10px 1fr;
  gap: 8px;
  align-items: center;
  font-size: 0.92rem;
}
.calendar-overlay .cal-event-time {
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
}
.calendar-overlay .cal-event-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--dot, #7986CB);
  justify-self: center;
}
.calendar-overlay .cal-event-title { font-weight: 500; }
.calendar-overlay .cal-event-loc   { opacity: 0.7; font-size: 0.82rem; }
.calendar-overlay .cal-event.is-past { opacity: 0.45; text-decoration: line-through; }
.calendar-overlay .cal-tomorrow .cal-events,
.calendar-overlay .cal-tomorrow .cal-allday-strip { opacity: 0.8; }
```

- [ ] **Step 2: Render calendar overlay in wall.js renderWeather**

In `public/js/pages/wall.js`, find `renderWeather`. ADD a calendar fetch alongside the existing weather fetch:

Find the line where weather data is fetched:
```bash
cd ~/projects/tally && grep -n "renderWeather\|/api/wall/weather\|weather-body" public/js/pages/wall.js | head
```

Inside `renderWeather`, ALSO fetch the calendar:
```js
  const calData = await api.get('/api/wall/calendar').catch(() => ({ skip: true }));
  const hasCal = !calData.skip;
```

Build the calendar overlay element when `hasCal`:

```js
function buildCalendarOverlay(d) {
  function fmtT(iso) {
    if (!iso) return '';
    const dt = new Date(iso);
    const h = dt.getHours() % 12 || 12;
    const m = String(dt.getMinutes()).padStart(2, '0');
    const ampm = dt.getHours() < 12 ? 'AM' : 'PM';
    return `${h}:${m} ${ampm}`;
  }
  const now = Date.now();
  function evRow(e, isToday) {
    const past = isToday && e.end && new Date(e.end).getTime() < now;
    return el('div', { class: 'cal-event' + (past ? ' is-past' : ''), style: { '--dot': e.calendar_color } }, [
      el('span', { class: 'cal-event-time' }, [fmtT(e.start)]),
      el('span', { class: 'cal-event-dot' }, []),
      el('div', { class: 'cal-event-body' }, [
        el('span', { class: 'cal-event-title' }, [e.summary]),
        e.location ? el('span', { class: 'cal-event-loc' }, [' · ' + e.location]) : null,
      ].filter(Boolean)),
    ]);
  }
  function alldayPill(e) {
    return el('span', { class: 'cal-allday-pill', style: { '--dot': e.calendar_color } }, [e.summary]);
  }
  const todayChunk = el('div', { class: 'cal-day cal-today' }, [
    el('div', { class: 'cal-day-label' }, ['Today']),
    (d.today.allDay.length > 0) ? el('div', { class: 'cal-allday-strip' }, d.today.allDay.map(alldayPill)) : null,
    el('div', { class: 'cal-events' }, d.today.timed.map(e => evRow(e, true))),
  ].filter(Boolean));
  const tomChunk = (d.tomorrow.allDay.length + d.tomorrow.timed.length > 0)
    ? el('div', { class: 'cal-day cal-tomorrow' }, [
        el('div', { class: 'cal-divider' }, ['Tomorrow']),
        (d.tomorrow.allDay.length > 0) ? el('div', { class: 'cal-allday-strip' }, d.tomorrow.allDay.map(alldayPill)) : null,
        el('div', { class: 'cal-events' }, d.tomorrow.timed.map(e => evRow(e, false))),
      ].filter(Boolean))
    : null;
  return el('div', { class: 'calendar-overlay' }, [todayChunk, tomChunk].filter(Boolean));
}
```

Inside `renderWeather`, where the weather body is constructed, wrap the `.weather-current` in a `.weather-body` div that toggles `.has-calendar` and appends the overlay when `hasCal`:

```js
  const bodyEl = el('div', { class: 'weather-body' + (hasCal ? ' has-calendar' : '') }, [
    el('div', { class: 'weather-current' }, [
      el('div', { class: 'temp' }, [`${data.current_temp}${u}`]),
      el('div', { class: 'hilo' }, [`H ${data.today_high}${u} · L ${data.today_low}${u}`]),
    ]),
    hasCal ? buildCalendarOverlay(calData) : null,
  ].filter(Boolean));
```

The exact insertion point depends on the current wall.js shape. If the existing renderWeather builds the weather body as a flat list of children of `.wall-page-weather`, restructure it so:
- `.wall-header` (first child)
- `.weather-body` (the new wrapper)
- `.weather-forecast` (last child)

- [ ] **Step 3: Syntax check + restart + smoke**

```bash
cd ~/projects/tally && node --check public/js/pages/wall.js && pm2 restart tally --update-env >/dev/null && sleep 1 && curl -sf -o /dev/null -w "wall=%{http_code} cal=" https://tally.thelopezfamily.org/wall && curl -sf -o /dev/null -w "%{http_code}\n" https://tally.thelopezfamily.org/api/wall/calendar
```
Expected: 200 / 200.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tally && git add public/css/layouts.css public/js/pages/wall.js && git commit -m "feat(wall): weather panel grows a calendar overlay column (today + tomorrow events)"
```

---

## Task 7: Admin Wall tab grows a Calendar card

**Files:**
- Modify: `public/js/pages/admin.js`

- [ ] **Step 1: Find renderWall and add Card 5**

```bash
cd ~/projects/tally && grep -n "renderWall\|Card 4: Sleep" public/js/pages/admin.js
```

In `renderWall`, at the end (after the Sleep card is appended), add a new Calendar card:

```js
  // ------- Card 5: Calendar -------
  const calCard = el('div', { class: 'card' }, [
    el('h4', { style: { marginBottom: 'var(--s3)' } }, ['Calendar']),
    el('div', { id: 'cal-card-body', class: 'muted' }, ['Loading…']),
  ]);
  host.appendChild(calCard);

  const url = new URL(location.href);
  const status = url.searchParams.get('wall_calendar_status');
  const errCode = url.searchParams.get('wall_calendar_error');
  if (status === 'connected') alert('Google Calendar connected.');
  if (errCode) alert('Google Calendar connect failed: ' + errCode);
  if (status || errCode) {
    url.searchParams.delete('wall_calendar_status');
    url.searchParams.delete('wall_calendar_error');
    history.replaceState({}, '', url.toString());
  }

  const calBody = calCard.querySelector('#cal-card-body');
  try {
    const r = await api.get('/api/admin/calendar/list');
    calBody.innerHTML = '';
    if (!r.connected) {
      calBody.appendChild(el('button', {
        class: 'btn btn-primary',
        onClick: () => { window.location.href = '/api/auth/google/start'; },
      }, ['Connect Google Calendar']));
      calBody.appendChild(el('div', { class: 'muted', style: { fontSize: '0.78rem', marginTop: '8px' } }, [
        'Requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env (see README).',
      ]));
    } else {
      const selectedSet = new Set((r.selected_ids || '').split(',').map(s => s.trim()).filter(Boolean));
      calBody.appendChild(el('div', { style: { marginBottom: 'var(--s3)' } }, ['Connected to Google.']));
      const checks = r.calendars.map(c => {
        const cb = el('input', {
          type: 'checkbox',
          checked: selectedSet.has(c.id) ? 'checked' : null,
          onChange: async (e) => {
            if (e.target.checked) selectedSet.add(c.id); else selectedSet.delete(c.id);
            const value = [...selectedSet].join(',');
            try {
              await api.patch('/api/admin/settings/wall_calendar_selected_ids', { value });
            } catch (err) {
              alert('Save failed: ' + err.message);
              e.target.checked = !e.target.checked;
            }
          },
        });
        return el('label', { class: 'row', style: { gap: '8px', cursor: 'pointer', marginBottom: '6px' } }, [
          cb,
          el('span', { style: { width: '12px', height: '12px', borderRadius: '50%', background: c.backgroundColor, display: 'inline-block' } }, []),
          el('span', {}, [c.summary]),
          c.primary ? el('span', { class: 'muted', style: { fontSize: '0.75rem' } }, ['(primary)']) : null,
        ].filter(Boolean));
      });
      calBody.appendChild(el('div', { class: 'stack' }, checks));
      calBody.appendChild(el('div', { class: 'row spaced', style: { marginTop: 'var(--s3)' } }, [
        el('button', { class: 'btn btn-ghost', onClick: async () => {
          try { await api.post('/api/admin/calendar/refresh-list'); renderWall(host); }
          catch (e) { alert('Refresh failed: ' + e.message); }
        } }, ['Refresh calendar list']),
        el('button', { class: 'btn btn-danger', onClick: async () => {
          if (!confirm('Disconnect Google Calendar?')) return;
          try { await api.post('/api/admin/calendar/disconnect'); renderWall(host); }
          catch (e) { alert('Disconnect failed: ' + e.message); }
        } }, ['Disconnect']),
      ]));
    }
  } catch (e) {
    calBody.textContent = 'Failed to load: ' + e.message;
  }
```

Confirm the `api` helper supports `api.patch` and `api.post` returning the parsed JSON. (It does, per the existing usage in admin.js.)

- [ ] **Step 2: Syntax check**

```bash
cd ~/projects/tally && node --check public/js/pages/admin.js && echo "ok"
```

- [ ] **Step 3: Commit**

```bash
cd ~/projects/tally && git add public/js/pages/admin.js && git commit -m "feat(admin): Wall tab gets Calendar card (Connect, multi-select, refresh, disconnect)"
```

---

## Task 8: README docs + run suite + tag + push

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Append README section**

In `README.md`, append a new section:

```markdown
## Wall calendar overlay (Google Calendar via OAuth)

The wall's weather panel shows today + tomorrow events from one or more Google
Calendars. To set this up:

1. **Create OAuth credentials in Google Cloud Console.**
   - Visit https://console.cloud.google.com, create or pick a project.
   - APIs & Services > Library: enable **Google Calendar API**.
   - APIs & Services > Credentials > Create credentials > OAuth client ID
     > Web application.
   - Authorized redirect URI: `https://your-host/api/auth/google/callback`.
2. **Drop the credentials in `.env`.**
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=https://your-host/api/auth/google/callback
   ```
3. **Restart Tally:** `pm2 restart tally --update-env`.
4. **Connect from the admin Wall tab.** Open admin, navigate to the Wall tab,
   scroll to the Calendar card, click **Connect Google Calendar**. Google asks
   you to consent to read-only calendar access. After consent you'll be
   redirected back to the Wall tab where a checklist of your calendars appears.
5. **Pick which calendars feed the wall.** Tick the boxes; the overlay renders
   their events within ~5 minutes.

If Google revokes access (you delete the OAuth grant or rotate the client
secret), the overlay collapses and the admin tab shows the Connect button
again. The refresh token in the DB is encrypted with a key derived from
`SESSION_SECRET`; if that secret changes you must reconnect.
```

- [ ] **Step 2: Run full suite**

```bash
cd ~/projects/tally && npm test 2>&1 | tail -8
```
Expected: ~360 tests, the 2 pre-existing `routes-steal.test.js` failures still failing, no new failures.

- [ ] **Step 3: Restart and smoke**

```bash
cd ~/projects/tally && pm2 restart tally --update-env >/dev/null && sleep 1 && curl -sf -o /dev/null -w "wall=%{http_code}\n" https://tally.thelopezfamily.org/wall
```

- [ ] **Step 4: Tag and push**

```bash
cd ~/projects/tally && git add README.md && git commit -m "docs: Google Calendar OAuth setup walk-through" && git tag -a v0.15.0-calendar-overlay -m "$(cat <<'EOF'
v0.15.0 - Calendar overlay on the weather panel

- Connect a Google account once from the admin Wall tab.
- Pick which calendars feed the wall via multi-select.
- Today + tomorrow events render inside the weather panel's empty
  region: all-day pills at the top, time-sorted timed events below,
  past events struck through, tomorrow dimmer than today.
- Each event gets a color dot pulled from its source calendar.
- 5-minute server-side cache; if Google revokes access the refresh
  token is cleared and the overlay collapses gracefully.
- Refresh token stored encrypted (AES-256-GCM keyed by SESSION_SECRET).
- No new npm dependencies; native fetch + crypto only.
EOF
)" && git push origin master --tags 2>&1 | tail -5
```

- [ ] **Step 5: Verify**

```bash
cd ~/projects/tally && git log --oneline -5 && git tag | tail -3
```

---

## Self-review (controller fills in at plan-writing time)

- [x] Every spec section maps to a task.
- [x] Migration 016 is one past 015.
- [x] No PATCH path for `wall_calendar_oauth_refresh` or `wall_calendar_list_cache` (only OAuth callback and admin endpoints write them).
- [x] State CSRF protection via cookie-session.
- [x] InvalidGrantError clears the stored refresh token everywhere it's caught.
- [x] All API calls go through native fetch; no new npm deps.
- [x] Tests cover: encrypt roundtrip + tamper, token cache, calendar list, events, OAuth start/callback, wall/calendar, admin list/refresh/disconnect.
- [x] No TBD/placeholder steps.
