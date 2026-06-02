import { Router } from 'express';
import { today, weekStart } from '../lib/dates.js';
import { calcWeekPoints } from '../lib/points.js';
import { currentStreak, isOnFreeze } from '../lib/streak.js';
import { wallBus } from '../lib/events.js';
import { runPayoutIfDue } from '../lib/payout.js';
import { sweepForfeits } from '../lib/forfeit.js';
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

// The wall renders radar as a small Leaflet map centered on the weather
// location (animated RainViewer tiles + faint CARTO base + a "you are here"
// dot). The client fetches the tile frames directly from RainViewer, so the
// server only needs to say whether radar is on and where to center it.
const RADAR_ZOOM = 8;
function radarBlock(db, lat, lon) {
  const row = db.prepare("SELECT value FROM settings WHERE key='wall_weather_radar'").get();
  const enabled = (row?.value ?? 'on') !== 'off';
  if (!enabled || !lat || !lon) return { enabled: false };
  return { enabled: true, lat: Number(lat), lon: Number(lon), zoom: RADAR_ZOOM };
}

export function wallRoutes() {
  const r = Router();

  r.get('/wall/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':ok\n\n');

    const onRefresh = () => res.write('event: refresh\ndata: {}\n\n');
    wallBus.on('refresh', onRefresh);
    res.on('close', () => wallBus.off('refresh', onRefresh));
  });

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
      return res.json({ ...weatherCache.data, unit, radar: radarBlock(db, lat, lon) });
    }
    try {
      const raw = await fetchOpenMeteo(lat, lon, unit);
      const parsed = parseForecast(raw);
      weatherCache = { key: cacheKey, data: parsed, fetchedAt: now };
      weatherLastSuccess = now;
      return res.json({ ...parsed, unit, radar: radarBlock(db, lat, lon) });
    } catch (err) {
      // Dedupe error logs to once per 5 min.
      if (now - weatherLastFailureLog > 5 * 60 * 1000) {
        console.error('[wall/weather] fetch failed:', err.message);
        weatherLastFailureLog = now;
      }
      // If we have a recent successful cache (within the stale-skip window), serve it.
      if (weatherCache && weatherCache.key === cacheKey && (now - weatherLastSuccess) < WEATHER_STALE_SKIP_MS) {
        return res.json({ ...weatherCache.data, unit, stale: true, radar: radarBlock(db, lat, lon) });
      }
      return res.json({ skip: true, reason: 'fetch failed' });
    }
  });

  r.get('/wall', (req, res) => {
    const db = req.app.get('db');
    runPayoutIfDue(db);
    sweepForfeits(db);
    const kids = db.prepare(`
      SELECT id, name, avatar_color, weekly_target_pts, streak_days, bank_cents
      FROM people WHERE role = 'kid' ORDER BY id
    `).all();

    const todayIso = today();
    const ws = weekStart(todayIso);

    const kidIds = kids.map(k => k.id);
    const assignmentRows = kidIds.length === 0 ? [] : db.prepare(`
      SELECT a.id, a.person_id, a.due_date, a.status, a.stolen_from, a.forfeited,
             c.title, c.weight, c.kind, c.points AS chore_points,
             sf.name AS stolen_from_name
      FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      LEFT JOIN people sf ON sf.id = a.stolen_from
      WHERE a.person_id IN (${kidIds.map(() => '?').join(',')})
        AND (a.due_date = ? OR (a.due_date < ? AND a.status NOT IN ('done','expired','rejected','excused')))
      ORDER BY a.due_date, c.title
    `).all(...kidIds, todayIso, todayIso);

    // Pre-compute totalWeight per kid (used both for the kid summary and per-row display_points)
    const totals = new Map();
    let total = 0, done = 0;
    for (const kid of kids) {
      kid.today = [];
      kid.overdue = [];
      const pts = calcWeekPoints(db, kid.id, ws);
      kid.points = pts.points;
      kid.percent = pts.percent;
      totals.set(kid.id, pts.totalWeight);
      kid.streak_days = currentStreak(db, kid.id);
      kid.on_freeze = isOnFreeze(db, kid.id);
    }
    for (const a of assignmentRows) {
      const kid = kids.find(k => k.id === a.person_id);
      if (!kid) continue;
      const target = kid.weekly_target_pts || 0;
      const totalWeight = totals.get(kid.id) || 0;
      if (a.kind === 'bonus') {
        a.display_points = a.chore_points;
        a.is_bonus = 1;
      } else {
        a.display_points = totalWeight > 0 ? Math.round(a.weight / totalWeight * target) : 0;
        a.is_bonus = 0;
      }
      const bucket = a.due_date === todayIso ? kid.today : kid.overdue;
      bucket.push(a);
      if (a.status !== 'excused') {
        total++;
        if (a.status === 'done') done++;
      }
    }
    const housePct = total === 0 ? 100 : Math.round((done / total) * 100);

    const bonuses = db.prepare(`
      SELECT c.id, c.title, c.points, c.anti_cheat
      FROM chores c
      LEFT JOIN assignments a ON a.chore_id = c.id
      WHERE c.kind = 'bonus' AND c.deleted_at IS NULL AND a.id IS NULL
      ORDER BY c.created_at DESC
    `).all();

    let streak_leader = null;
    for (const kid of kids) {
      if (kid.streak_days > 0) {
        if (!streak_leader
            || kid.streak_days > streak_leader.streak_days
            || (kid.streak_days === streak_leader.streak_days && kid.name < streak_leader.name)) {
          streak_leader = { name: kid.name, color: kid.avatar_color, streak_days: kid.streak_days };
        }
      }
    }

    res.json({ kids, house_pct: housePct, today: todayIso, bonuses, streak_leader });
  });

  return r;
}
