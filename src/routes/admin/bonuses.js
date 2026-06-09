import { Router } from 'express';
import { requireRole } from '../../auth.js';
import { notifyWall } from '../../lib/events.js';
import { sendToPerson } from '../../lib/push.js';

const ALLOWED_FIELDS = [
  'title', 'description', 'points', 'anti_cheat', 'photo_prompt',
  'min_points', 'max_points', 'days_to_ripen',
];

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function validateRipeningFields(data) {
  if (data.min_points !== undefined) {
    const n = Number(data.min_points);
    if (!Number.isInteger(n) || n < 1) return 'min_points must be an integer >= 1';
    data.min_points = n;
  }
  if (data.max_points !== undefined) {
    const n = Number(data.max_points);
    if (!Number.isInteger(n) || n < 1) return 'max_points must be an integer >= 1';
    data.max_points = n;
  }
  if (data.min_points !== undefined && data.max_points !== undefined && data.max_points < data.min_points) {
    return 'max_points must be >= min_points';
  }
  if (data.days_to_ripen !== undefined) {
    const n = Number(data.days_to_ripen);
    if (!Number.isInteger(n) || n < 1 || n > 30) return 'days_to_ripen must be an integer 1..30';
    data.days_to_ripen = n;
  }
  return null;
}

export function adminBonusesRoutes() {
  const r = Router();
  r.use(requireRole('parent'));

  r.get('/bonuses', (req, res) => {
    const db = req.app.get('db');
    const rows = db.prepare(`
      SELECT c.id, c.title, c.description, c.points, c.anti_cheat,
             c.photo_prompt, c.created_at,
             c.min_points, c.max_points, c.current_points, c.days_to_ripen,
             c.ripens_from, c.ripens_full_on,
             a.id AS assignment_id,
             a.person_id AS claimed_by,
             a.status AS assignment_status,
             a.due_date AS claimed_date,
             p.name AS claimed_by_name,
             p.avatar_color AS claimed_by_color
      FROM chores c
      LEFT JOIN assignments a ON a.chore_id = c.id
      LEFT JOIN people p ON p.id = a.person_id
      WHERE c.kind = 'bonus' AND c.deleted_at IS NULL
      ORDER BY c.created_at DESC
    `).all();
    res.json({ bonuses: rows });
  });

  r.post('/bonuses', (req, res) => {
    const db = req.app.get('db');
    const data = pickFields(req.body || {});
    if (!data.title || !String(data.title).trim()) {
      return res.status(400).json({ error: 'title required' });
    }
    if (typeof data.points !== 'number' || !Number.isFinite(data.points) || data.points <= 0) {
      return res.status(400).json({ error: 'points required (positive number)' });
    }
    if (data.anti_cheat && !['honor', 'photo', 'approval'].includes(data.anti_cheat)) {
      return res.status(400).json({ error: 'anti_cheat must be honor, photo, or approval' });
    }
    const err = validateRipeningFields(data);
    if (err) return res.status(400).json({ error: err });
    if (data.min_points !== undefined) {
      data.current_points = data.min_points;
      data.ripens_from    = todayIso();
    }

    const cols = ['kind', 'recurs', 'default_assignees', ...Object.keys(data)];
    const vals = ['bonus', 'none', '', ...Object.values(data)];
    const bonus = db.prepare(`
      INSERT INTO chores (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) RETURNING *
    `).get(...vals);
    res.json({ bonus });
    notifyWall();
    const kids = db.prepare("SELECT id FROM people WHERE role = 'kid'").all();
    for (const k of kids) {
      sendToPerson(db, k.id, { title: 'New bonus!', body: `${bonus.title} · +${bonus.points} pts`, tag: 'bonus' });
    }
  });

  r.patch('/bonuses/:id', (req, res) => {
    const db = req.app.get('db');
    const claimed = db.prepare(
      "SELECT id FROM assignments WHERE chore_id = ?"
    ).get(req.params.id);
    if (claimed) {
      return res.status(409).json({ error: 'Bonus already claimed, cannot edit' });
    }
    const data = pickFields(req.body || {});
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'nothing to update' });
    }
    const err = validateRipeningFields(data);
    if (err) return res.status(400).json({ error: err });
    if (data.min_points !== undefined || data.max_points !== undefined) {
      if (data.min_points !== undefined) data.current_points = data.min_points;
      data.ripens_from    = todayIso();
      data.ripens_full_on = null;
    }
    const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
    const bonus = db.prepare(`
      UPDATE chores SET ${sets} WHERE id = ? AND kind = 'bonus' AND deleted_at IS NULL RETURNING *
    `).get(...Object.values(data), req.params.id);
    if (!bonus) return res.status(404).json({ error: 'Not found' });
    res.json({ bonus });
  });

  r.delete('/bonuses/:id', (req, res) => {
    const db = req.app.get('db');
    const r2 = db.prepare(`
      UPDATE chores SET deleted_at = datetime('now')
      WHERE id = ? AND kind = 'bonus' AND deleted_at IS NULL
    `).run(req.params.id);
    if (r2.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
    notifyWall();
  });

  return r;
}

function pickFields(body) {
  const out = {};
  for (const f of ALLOWED_FIELDS) {
    if (body[f] !== undefined) out[f] = body[f];
  }
  return out;
}
