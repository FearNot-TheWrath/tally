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
