import { Router } from 'express';
import { requireRole } from '../../auth.js';
import { generateForToday } from '../../lib/assignments.js';

const ALLOWED_FIELDS = [
  'title', 'description', 'points', 'kind',
  'recurs', 'recurs_days', 'recurs_anchor', 'due_time',
  'anti_cheat', 'late_tax_pct', 'photo_prompt', 'default_assignees',
];

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
    const r2 = db.prepare(`
      UPDATE chores SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL
    `).run(req.params.id);
    if (r2.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
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
