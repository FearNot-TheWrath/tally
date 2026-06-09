# Calendar Overlay (Wall Suite Phase 2) — Design Spec

**Date:** 2026-06-08
**Status:** Approved for plan-writing
**Target release:** v0.15.0-calendar-overlay

## Summary

Overlay today + tomorrow's Google Calendar events onto the weather panel. No new rotation slot, no standalone calendar panel — calendar info lives inside the empty region of the weather panel. One-time admin setup connects a Google account via OAuth, picks which calendars feed the wall, and the wall renders the merged events with their calendar's color dot. When the day + next day are empty, the overlay collapses gracefully.

## Goals

- See today's events at a glance whenever the weather panel is visible.
- One-time OAuth setup; subsequent operation is silent.
- Multi-calendar merge (family + kids' schools + parish ...), each event tagged with its source calendar's color.
- Safe storage of OAuth credentials.
- No regression to the existing weather panel layout.

## Non-goals

- No separate calendar panel slot (decided in brainstorm).
- No event creation / editing — read-only.
- No event-detail popups on the wall.
- No reminders / notifications about upcoming events.
- No mobile-app integration.

## One-time Google Cloud setup (user task)

The README will document these steps; spec lists for completeness:

1. Visit console.cloud.google.com, create or pick a project.
2. APIs & Services → Library → enable **Google Calendar API**.
3. APIs & Services → Credentials → Create credentials → OAuth client ID → Web application.
4. Authorized redirect URI: `https://tally.thelopezfamily.org/api/auth/google/callback`.
5. Copy `CLIENT_ID` and `CLIENT_SECRET` into Tally's `.env`:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=https://tally.thelopezfamily.org/api/auth/google/callback
   ```
6. `pm2 restart tally --update-env`.
7. Open admin → Wall → click **Connect Google Calendar**.

## OAuth flow

```
Admin clicks "Connect Google Calendar"
   GET /api/auth/google/start
     - Generate random state token, store in cookie-session as `oauth_state`.
     - Redirect to https://accounts.google.com/o/oauth2/v2/auth?
         client_id=...&
         redirect_uri=...&
         response_type=code&
         scope=https://www.googleapis.com/auth/calendar.readonly&
         access_type=offline&
         prompt=consent&
         state=<random>

User approves on Google's consent screen

Google redirects to:
   GET /api/auth/google/callback?code=...&state=...
     - Verify `state` matches cookie-session.
     - POST to https://oauth2.googleapis.com/token with code, client_id, secret, redirect_uri, grant_type=authorization_code.
     - Receive { access_token, refresh_token, expires_in, ... }.
     - Encrypt refresh_token with crypto-settings helper.
     - Save to settings.wall_calendar_oauth_refresh.
     - Fetch calendar list with the access_token (one call).
     - Cache calendar list to settings.wall_calendar_list_cache (JSON: [{id, summary, backgroundColor, primary}, ...]).
     - Redirect back to /admin#wall.
```

If the user pulls access from Google later (or the secret rotates), the next call to use the refresh token will fail with `invalid_grant`. We catch that, clear `wall_calendar_oauth_refresh`, and the overlay reverts to "Connect" mode.

## Token storage / encryption

New module `src/lib/crypto-settings.js`:

```js
// AES-256-GCM with key derived from SESSION_SECRET via scrypt.
// Encrypted payload format (base64): [12-byte nonce][16-byte auth tag][ciphertext]

export function encryptForSetting(plaintext, secret) { ... }
export function decryptFromSetting(ciphertext, secret) { ... }  // returns null on tamper / bad key
```

The setting `wall_calendar_oauth_refresh` stores the base64 ciphertext. On every server-side use, we decrypt with `process.env.SESSION_SECRET` (the same secret already used for cookie-session, already in `.env`).

If `SESSION_SECRET` ever changes, the stored refresh token becomes undecryptable; we treat it as "not connected" and the admin re-OAuths. Same as Google revoking access. Documented in README.

## Google API client

New module `src/lib/wall/google-cal.js`:

```js
// All HTTPS calls go through Node's built-in fetch. No SDK dependency.
//
// exports:
//   exchangeAuthCode(code, redirectUri)   -> { access_token, refresh_token, expires_in }
//   refreshAccessToken(refreshToken)      -> { access_token, expires_in }     (throws InvalidGrantError on failure)
//   fetchCalendarList(accessToken)        -> [{ id, summary, backgroundColor, primary }, ...]
//   fetchCalendarEvents(accessToken, calendarId, timeMin, timeMax)
//                                         -> [{ id, summary, start, end, location }, ...]
//
// One short-lived in-memory access-token cache keyed by refresh_token, so we
// only mint a new access token when the cached one expires.
```

`InvalidGrantError` is a named error class so the calling code can detect "user revoked Google access" and clear the stored refresh token.

## Routes

| route | auth | purpose |
|---|---|---|
| `GET  /api/auth/google/start` | parent | Generate state, redirect to Google. |
| `GET  /api/auth/google/callback` | none (verified by state cookie) | Exchange code, save refresh, redirect to admin. |
| `GET  /api/wall/calendar` | none (wall-public) | Returns today + tomorrow events grouped + sorted. `{ skip: true }` if not connected, no selected calendars, or fetch failed. |
| `GET  /api/admin/calendar/list` | parent | Returns the cached calendar list for the multi-select picker. |
| `POST /api/admin/calendar/refresh-list` | parent | Force-refresh the cached calendar list from Google. |
| `POST /api/admin/calendar/disconnect` | parent | Clear the encrypted refresh token + selected ids + list cache. |

## Calendar fetch + merge

`GET /api/wall/calendar` flow:

1. Read `wall_calendar_oauth_refresh` and `wall_calendar_selected_ids` from settings. If either is empty, return `{ skip: true, reason: 'not connected' }` (or `'no calendars selected'`).
2. Check 5-minute in-memory merged-events cache. If fresh, return it.
3. Decrypt refresh token. Get a fresh access token (or use cached access token from `google-cal.js`).
4. For each selected calendar ID, fetch events in `[now, tomorrow 23:59:59 local]` window. Use `singleEvents=true, orderBy=startTime, maxResults=50` per call.
5. Merge: tag each event with its source calendar's `id`, `summary`, `backgroundColor`. Drop cancelled events (`status === 'cancelled'`). Sort by start time.
6. Separate timed events from all-day events (an event is all-day when `start.date` is set instead of `start.dateTime`).
7. Group into `{ today: { allDay: [...], timed: [...] }, tomorrow: { allDay: [...], timed: [...] } }`.
8. If today's `(allDay.length + timed.length) === 0` AND tomorrow's is also `0`, return `{ skip: true, reason: 'no events' }`.
9. Otherwise return the grouped object, cache, respond.

On `InvalidGrantError`: clear `wall_calendar_oauth_refresh`, return `{ skip: true, reason: 'reconnect required' }`, and the admin UI surfaces a banner on next render.

## Weather panel layout: making room for the overlay

Today the weather panel renders a `.wall-page-weather` flex column with `.weather-current` (centered big temp + hilo) and `.weather-forecast` (3-day strip).

Change it to a CSS grid:

```css
.wall-page-weather {
  display: grid;
  grid-template-rows: auto 1fr auto;   /* header / body / forecast */
}
.weather-body {
  display: grid;
  grid-template-columns: 1fr minmax(280px, 32%);
  gap: 32px;
  align-items: center;
}
.weather-overlay-calendar { ... }
```

So the weather body becomes a two-column split: current temp + condition on the left, calendar overlay on the right (the empty area in the user's screenshot). The forecast strip stays at the bottom.

When the calendar is empty / skipping, the JS sets `.weather-body` to a single-column layout (drop the calendar column). The big-temp side recenters.

## Calendar overlay rendering

`renderCalendarOverlay(host, data)`:

```
<div class="calendar-overlay">
  <div class="cal-day cal-today">
    <div class="cal-day-label">Today</div>
    <div class="cal-allday-strip">
      <span class="cal-allday-pill" style="--dot:#0BA47C">Last day of school</span>
      ...
    </div>
    <div class="cal-events">
      <div class="cal-event">
        <span class="cal-event-time">7:00 PM</span>
        <span class="cal-event-dot" style="background:#F4511E"></span>
        <span class="cal-event-title">Robotics club</span>
        <span class="cal-event-loc">· Hutto HS</span>
      </div>
      ...
    </div>
  </div>
  <div class="cal-divider">Tomorrow</div>
  <div class="cal-day cal-tomorrow"> ... </div>
</div>
```

- Past events from today (where `end < now`) get class `is-past` → 0.45 opacity + strikethrough.
- Tomorrow's events render at 0.8 opacity overall so the eye still goes to today first.
- All-day pills are smaller, get the calendar color as a tiny dot.
- When the rendered height exceeds available space, apply the existing `.tasks-marquee` pattern to `.cal-events`: duplicate the children and CSS-animate vertically. (Re-use the chores marquee CSS class.)

Color dots: a small 8px circle. Use the calendar's `backgroundColor` from the calendar list cache (Google provides per-calendar hex like `#7986CB`). All-day pills use the same color as a left border.

## Admin Wall tab additions

The Wall tab grows a fifth card after "Sleep": **Calendar**.

**When not connected** (`wall_calendar_oauth_refresh` is empty):
- Big "Connect Google Calendar" button → navigates browser to `/api/auth/google/start`.
- Small muted helper text noting the required env vars (with a link to the README section).

**When connected** (refresh token present):
- "Connected to Google" header.
- A list of all calendars (from `wall_calendar_list_cache`):
  - Each row: checkbox, color swatch, calendar name, "Primary" badge if primary.
  - On change: PATCH `wall_calendar_selected_ids` with the new comma list. Refresh card on success.
- A "Refresh calendar list" button → POST `/api/admin/calendar/refresh-list`. Useful if the user just added a new calendar in Google.
- A "Disconnect" button → POST `/api/admin/calendar/disconnect`, confirm dialog first. Reverts the card to the not-connected state.

## Settings additions

New keys (migration 016):

| key | default | notes |
|---|---|---|
| `wall_calendar_oauth_refresh` | `` | base64 ciphertext of the Google refresh token. Empty = not connected. |
| `wall_calendar_selected_ids` | `` | comma list of selected calendar IDs. |
| `wall_calendar_list_cache` | `[]` | JSON array of `{id, summary, backgroundColor, primary, accessRole}` for the picker. |

Settings PATCH validators:
- `wall_calendar_selected_ids`: any string up to 4096 chars (calendar IDs are long).
- `wall_calendar_oauth_refresh` and `wall_calendar_list_cache`: not whitelisted for direct PATCH; only the OAuth callback and disconnect routes write them.

`/api/wall/config` does NOT expose `wall_calendar_oauth_refresh`. It MAY expose a `calendar_connected: boolean` for the admin UI to read.

## Error handling

- **OAuth callback state mismatch**: redirect to `/admin?wall_calendar_error=state` with a flash banner.
- **OAuth token exchange fails**: redirect to `/admin?wall_calendar_error=exchange` with the underlying message logged server-side.
- **InvalidGrantError on calendar fetch**: clear refresh, return `{ skip: true, reason: 'reconnect required' }`. Admin sees "Reconnect required" banner.
- **Google API 429 (rate limit)**: cache stays in effect, log once per 5 minutes. The 5-minute fetch cache already keeps us well within Google's quota.
- **Network failure**: serve stale cache if within 30 minutes, otherwise `skip: true`. Same pattern as weather.

## Testing

Unit tests:
- `tests/lib-crypto-settings.test.js` — encrypt / decrypt roundtrip, tamper detection (returns null), wrong key returns null.
- `tests/lib-wall-google-cal.test.js` — token exchange happy path + 4xx error (mock fetch), refresh token happy + invalid_grant → throws InvalidGrantError, fetch calendar list + events with mock fetch, access-token cache hit/miss.
- `tests/routes-auth-google.test.js` — start route redirects with state + scope, callback verifies state, callback exchanges code and stores encrypted refresh, callback rejects mismatched state.
- `tests/routes-wall-calendar.test.js` — endpoint returns skip when not connected, returns skip when no calendars selected, returns grouped events with mock fetch, returns skip on InvalidGrantError and clears the stored refresh token.
- `tests/routes-admin-calendar.test.js` — list, refresh-list, disconnect roundtrip.

Manual smoke:
- Run through the README OAuth setup once.
- Connect, pick one calendar, verify event shows on the wall.
- Toggle calendars on/off, see overlay update within ~5 min.
- Disconnect, verify the "Connect" button returns.
- Force-fail OAuth (delete refresh from DB), verify Reconnect banner.

## Files touched

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
src/routes/admin/settings.js          add wall_calendar_selected_ids to EDITABLE_KEYS, validator
src/routes/wall.js                    add /api/wall/calendar + admin calendar routes; also expose calendar_connected in /api/wall/config (optional, for admin UI)
src/app.js                            mount /api/auth/google routes
public/css/layouts.css                .calendar-overlay, .cal-day, .cal-event, weather body grid
public/js/pages/wall.js               weather render grows a calendar column when data present
public/js/pages/admin.js              Wall tab gets a Calendar card; OAuth Connect button; multi-select
.env.example                          GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
README.md                             Google Cloud setup walk-through
```

## Open decisions deferred to plan-writing

- Whether `/api/auth/google/callback` returns a friendly success page vs immediately redirecting to `/admin#wall`. Lean toward immediate redirect with a `?wall_calendar_status=connected` query param the admin UI surfaces as a one-time toast.
- Whether to verify the OAuth `state` token via cookie-session OR sign with `SESSION_SECRET`. Lean toward cookie-session (simpler; the user is already authenticated to land on the start route).

## Out of scope (explicit, repeated)

- Apple Calendar / iCal subscriptions.
- Per-kid calendars surfaced separately.
- Event creation, editing, RSVPs.
- Reminders or push notifications about events.
- Mobile app.
- Calendar panel as a standalone rotation slot — decided in brainstorm. Overlay only.

## Phasing

Single phase, single tag (`v0.15.0-calendar-overlay`).
