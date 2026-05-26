import { Router } from 'express';
import { today } from '../lib/dates.js';

export function wallRoutes() {
  const r = Router();

  r.get('/wall', (req, res) => {
    const db = req.app.get('db');
    const kids = db.prepare(`
      SELECT id, name, avatar_color, weekly_target_pts, streak_days
      FROM people WHERE role = 'kid' ORDER BY id
    `).all();

    const todayIso = today();
    const assignmentRows = db.prepare(`
      SELECT a.id, a.person_id, a.due_date, a.status,
             c.title, c.points
      FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      WHERE a.person_id IN (${kids.map(() => '?').join(',') || 'NULL'})
        AND (a.due_date = ? OR (a.due_date < ? AND a.status NOT IN ('done','expired','rejected')))
      ORDER BY a.due_date, c.title
    `).all(...kids.map(k => k.id), todayIso, todayIso);

    let total = 0, done = 0;
    for (const kid of kids) {
      kid.today = [];
      kid.overdue = [];
    }
    for (const a of assignmentRows) {
      const kid = kids.find(k => k.id === a.person_id);
      if (!kid) continue;
      const bucket = a.due_date === todayIso ? kid.today : kid.overdue;
      bucket.push(a);
      total++;
      if (a.status === 'done') done++;
    }
    const housePct = total === 0 ? 100 : Math.round((done / total) * 100);

    res.json({ kids, house_pct: housePct, today: todayIso });
  });

  return r;
}
