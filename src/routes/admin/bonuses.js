import { Router } from 'express';
import { requireRole } from '../../auth.js';

const ALLOWED_FIELDS = [
  'title', 'description', 'points', 'anti_cheat', 'photo_prompt',
];

export function adminBonusesRoutes() {
  const r = Router();
  r.use(requireRole('parent'));

  r.get('/bonuses', (req, res) => {
    const db = req.app.get('db');
    const rows = db.prepare(`
      SELECT c.id, c.title, c.description, c.points, c.anti_cheat,
             c.photo_prompt, c.created_at,
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

    const cols = ['kind', 'recurs', 'default_assignees', ...Object.keys(data)];
    const vals = ['bonus', 'none', '', ...Object.values(data)];
    const bonus = db.prepare(`
      INSERT INTO chores (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) RETURNING *
    `).get(...vals);
    res.json({ bonus });
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
