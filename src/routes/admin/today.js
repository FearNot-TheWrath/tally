import { Router } from 'express';
import { requireRole } from '../../auth.js';
import { today } from '../../lib/dates.js';

export function adminTodayRoutes() {
  const r = Router();
  r.use(requireRole('parent'));

  r.get('/today', (req, res) => {
    const db = req.app.get('db');
    const t = today();
    const kids = db.prepare(`
      SELECT id, name, avatar_color FROM people WHERE role = 'kid' ORDER BY name
    `).all();

    let total = 0, done = 0;
    for (const k of kids) {
      const rows = db.prepare(`
        SELECT status, due_date FROM assignments
        WHERE person_id = ?
          AND (due_date = ? OR (due_date < ? AND status NOT IN ('done','expired','rejected')))
      `).all(k.id, t, t);
      k.today_total = rows.filter(r => r.due_date === t).length;
      k.today_done = rows.filter(r => r.due_date === t && r.status === 'done').length;
      k.overdue = rows.filter(r => r.due_date !== t).length;
      total += k.today_total;
      done += k.today_done;
    }
    res.json({
      house_pct: total === 0 ? 100 : Math.round((done / total) * 100),
      kids, total, done, today: t,
    });
  });

  return r;
}
