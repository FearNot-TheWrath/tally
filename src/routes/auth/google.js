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
