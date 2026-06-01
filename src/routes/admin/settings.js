import { Router } from 'express';
import { requireRole } from '../../auth.js';

// Whitelist of settings the API can write. Read access returns everything
// in READABLE_KEYS (no secrets — secrets like admin_pin_hash never appear).
const EDITABLE_KEYS = new Set([
  'steal_unlock_time',
  'streak_warning_time',
  'late_tax_pct_default',
  'reminder_time',
  'payout_day',
  'payout_time',
  'photo_retention_days',
  'wall_theme',
  'school_deadline_time',
]);

const READABLE_KEYS = new Set([
  ...EDITABLE_KEYS,
]);

export function adminSettingsRoutes() {
  const r = Router();
  r.use(requireRole('parent'));

  r.get('/settings', (req, res) => {
    const db = req.app.get('db');
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const settings = {};
    for (const row of rows) {
      if (READABLE_KEYS.has(row.key)) settings[row.key] = row.value;
    }
    res.json({ settings });
  });

  r.patch('/settings/:key', (req, res) => {
    const db = req.app.get('db');
    const key = req.params.key;
    if (!EDITABLE_KEYS.has(key)) {
      return res.status(400).json({ error: 'Setting is not editable' });
    }
    const { value } = req.body || {};
    if (typeof value !== 'string') {
      return res.status(400).json({ error: 'value must be a string' });
    }
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
    res.json({ setting: { key, value } });
  });

  return r;
}
