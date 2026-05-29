import { Router } from 'express';
import { requireRole } from '../../auth.js';
import { today } from '../../lib/dates.js';

export function adminDayReviewRoutes() {
  const r = Router();
  r.use(requireRole('parent'));

  r.get('/day-review', (req, res) => {
    const db = req.app.get('db');
    const date = req.query.date || today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }

    const rows = db.prepare(`
      SELECT a.id, a.status, a.note, a.photo_path, a.due_date,
             a.submitted_at, a.approved_at, a.approved_by, a.points_earned,
             c.title AS chore_title, c.points AS chore_points, c.anti_cheat,
             p.id AS kid_id, p.name AS kid_name, p.avatar_color AS kid_color,
             ap.name AS approver_name
      FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      JOIN people p ON p.id = a.person_id
      LEFT JOIN people ap ON ap.id = a.approved_by
      WHERE a.due_date = ?
        AND c.anti_cheat IN ('photo', 'approval')
      ORDER BY p.name, c.title
    `).all(date);

    const items = rows.map(row => ({
      ...row,
      photos: db.prepare('SELECT path FROM assignment_photos WHERE assignment_id = ? ORDER BY id').all(row.id)
        .map(p => `/api/uploads/${relFromUploads(p.path)}`),
    }));

    res.json({ date, items });
  });

  return r;
}

function relFromUploads(absPath) {
  const i = absPath.indexOf('uploads/');
  if (i === -1) return absPath.split(/[/\\]/).pop();
  return absPath.slice(i + 'uploads/'.length);
}
