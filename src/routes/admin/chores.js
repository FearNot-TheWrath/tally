import { Router } from 'express';
import { requireRole } from '../../auth.js';
import { generateForToday } from '../../lib/assignments.js';

const ALLOWED_FIELDS = [
  'title', 'description', 'points', 'kind',
  'recurs', 'recurs_days', 'recurs_anchor', 'due_time',
  'anti_cheat', 'late_tax_pct', 'photo_prompt', 'default_assignees',
  'weight', 'unstealable', 'is_school_work',
  'min_points', 'max_points', 'days_to_ripen',
  'current_points', 'ripens_from', 'ripens_full_on',
];

function validateBonusFields(data) {
  // Only enforce when the row IS a bonus (caller checks). All three fields optional;
  // when present they must be sane.
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

function todayIso() {
  // ISO date in local-time, matching the migration's date('now','localtime').
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

export function adminChoresRoutes() {
  const r = Router();
  r.use(requireRole('parent'));

  r.get('/chores', (req, res) => {
    const db = req.app.get('db');
    const chores = db.prepare(`
      SELECT * FROM chores WHERE deleted_at IS NULL ORDER BY title
    `).all();
    res.json({ chores });
  });

  r.post('/chores', (req, res) => {
    const db = req.app.get('db');
    const data = pickFields(req.body || {});
    if (!data.title) return res.status(400).json({ error: 'title required' });
    const err = validateBonusFields(data);
    if (err) return res.status(400).json({ error: err });
    // For new bonus chores, seed the ripening cycle.
    if (data.kind === 'bonus' && data.min_points !== undefined) {
      data.current_points = data.min_points;
      data.ripens_from    = todayIso();
    }
    const cols = Object.keys(data);
    const chore = db.prepare(`
      INSERT INTO chores (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) RETURNING *
    `).get(...cols.map(c => data[c]));
    generateForToday(db);
    res.json({ chore });
  });

  r.patch('/chores/:id', (req, res) => {
    const db = req.app.get('db');
    const data = pickFields(req.body || {});
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'nothing to update' });
    const err = validateBonusFields(data);
    if (err) return res.status(400).json({ error: err });
    // If min_points or max_points changes, restart the ripening cycle so the
    // wall doesn't show "current=8, min=2, max=15" stuck mid-ramp.
    if (data.min_points !== undefined || data.max_points !== undefined) {
      const newMin = data.min_points !== undefined ? data.min_points : null;
      if (newMin !== null) data.current_points = newMin;
      data.ripens_from    = todayIso();
      data.ripens_full_on = null;
    }
    const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
    const chore = db.prepare(`
      UPDATE chores SET ${sets} WHERE id = ? RETURNING *
    `).get(...Object.values(data), req.params.id);
    if (!chore) return res.status(404).json({ error: 'Not found' });
    generateForToday(db);
    res.json({ chore });
  });

  r.delete('/chores/:id', (req, res) => {
    const db = req.app.get('db');
    const soft = db.prepare(`
      UPDATE chores SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL
    `).run(req.params.id);
    if (soft.changes === 0) return res.status(404).json({ error: 'Not found' });
    // Clean up not-yet-completed assignments so they don't keep appearing on
    // the kid's home or the wall after the parent deleted the chore.
    // Done/rejected/expired ones stay as history.
    const cleanup = db.prepare(`
      DELETE FROM assignments
      WHERE chore_id = ?
        AND status NOT IN ('done', 'rejected', 'expired')
    `).run(req.params.id);
    res.json({ ok: true, removed_assignments: cleanup.changes });
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
