import { Router } from 'express';
import { requireRole } from '../../auth.js';
import { geocodeLocation } from '../../lib/wall/geocode.js';

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
  'wall_enabled_panels',
  'wall_chores_dwell_sec',
  'wall_other_dwell_sec',
  'wall_weather_lat',
  'wall_weather_lon',
  'wall_weather_unit',
  'wall_sleep_start',
  'wall_sleep_end',
  'wall_sleep_clock_style',
  'wall_weather_radar',
  'wall_verse_dwell_sec',
  'wall_smart_cycle',
  'wall_weather_dwell_sec',
  'wall_calendar_dwell_sec',
  'wall_weather_location',
  'wall_calendar_selected_ids',
]);

const READABLE_KEYS = new Set([
  ...EDITABLE_KEYS,
]);

const DAY_NAMES = new Set(['sunday','monday','tuesday','wednesday','thursday','friday','saturday']);

const WALL_PANEL_KEYS = new Set(['chores', 'weather', 'verse', 'calendar', 'verse-fact']);
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

  r.patch('/settings/:key', async (req, res) => {
    const db = req.app.get('db');
    const key = req.params.key;
    if (!EDITABLE_KEYS.has(key)) {
      return res.status(400).json({ error: 'Setting is not editable' });
    }
    const { value } = req.body || {};
    if (typeof value !== 'string') {
      return res.status(400).json({ error: 'value must be a string' });
    }
    if (key === 'payout_day' && !DAY_NAMES.has(value)) {
      return res.status(400).json({ error: 'payout_day must be a day name (sunday..saturday)' });
    }
    if (key === 'wall_enabled_panels' && !isValidEnabledPanels(value)) {
      return res.status(400).json({ error: 'wall_enabled_panels must be a comma list containing "chores"' });
    }
    if ((key === 'wall_chores_dwell_sec' || key === 'wall_other_dwell_sec' || key === 'wall_verse_dwell_sec') && !isIntInRange(value, 5, 600)) {
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
    if (key === 'wall_weather_radar' && value !== 'on' && value !== 'off') {
      return res.status(400).json({ error: 'wall_weather_radar must be on or off' });
    }
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
    if (key === 'wall_calendar_selected_ids' && (typeof value !== 'string' || value.length > 4096)) {
      return res.status(400).json({ error: 'wall_calendar_selected_ids must be a string up to 4096 chars' });
    }
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
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
    res.json({ setting: { key, value } });
  });

  return r;
}
