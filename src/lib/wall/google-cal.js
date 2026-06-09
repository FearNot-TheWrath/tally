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
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`fetchCalendarList ${r.status}: ${t.slice(0, 200)}`);
  }
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
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`fetchCalendarEvents ${r.status}: ${t.slice(0, 200)}`);
  }
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
