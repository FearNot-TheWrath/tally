import { Router } from 'express';
import { requireRole } from '../../auth.js';

const ALLOWED_FIELDS = [
  'name', 'dob', 'role', 'avatar_color',
  'weekly_target_pts', 'base_pay_cents', 'bonus_rate_cents',
  'freeze_start', 'freeze_end',
];

export function adminPeopleRoutes() {
  const r = Router();
  r.use(requireRole('parent'));

  r.get('/people', (req, res) => {
    const db = req.app.get('db');
    const people = db.prepare(`
      SELECT * FROM people WHERE role IN ('kid','parent') ORDER BY role DESC, name
    `).all();
    res.json({ people });
  });

  r.post('/people', (req, res) => {
    const db = req.app.get('db');
    const data = pickFields(req.body || {});
    if (!data.name || !data.role) return res.status(400).json({ error: 'name and role required' });
    if (!['kid','parent'].includes(data.role)) return res.status(400).json({ error: 'invalid role' });
    const cols = Object.keys(data);
    const stmt = db.prepare(`
      INSERT INTO people (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) RETURNING *
    `);
    const person = stmt.get(...cols.map(c => data[c]));
    res.json({ person });
  });

  r.patch('/people/:id', (req, res) => {
    const db = req.app.get('db');
    const data = pickFields(req.body || {});
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'nothing to update' });
    const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
    const person = db.prepare(`
      UPDATE people SET ${sets} WHERE id = ? RETURNING *
    `).get(...Object.values(data), req.params.id);
    if (!person) return res.status(404).json({ error: 'Not found' });
    res.json({ person });
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
