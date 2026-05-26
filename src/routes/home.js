import { Router } from 'express';
import { requireRole, requireAnyAuth } from '../auth.js';
import { today } from '../lib/dates.js';

export function homeRoutes() {
  const r = Router();

  r.get('/home', requireRole('kid'), (req, res) => {
    const db = req.app.get('db');
    const personId = req.user.person_id;
    const person = db.prepare(`
      SELECT id, name, avatar_color, weekly_target_pts, base_pay_cents, bonus_rate_cents,
             bank_cents, streak_days
      FROM people WHERE id = ?
    `).get(personId);

    const assignments = db.prepare(`
      SELECT a.id, a.due_date, a.status, a.note, c.title, c.points, c.anti_cheat
      FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      WHERE a.person_id = ?
        AND (a.due_date = ? OR (a.due_date < ? AND a.status NOT IN ('done','expired','rejected')))
      ORDER BY a.due_date, c.title
    `).all(personId, today(), today());

    const todayList = assignments.filter(a => a.due_date === today());
    const overdueList = assignments.filter(a => a.due_date !== today());

    res.json({
      person,
      today: todayList,
      overdue: overdueList,
    });
  });

  r.post('/assignments/:id/done', requireAnyAuth, (req, res) => {
    const db = req.app.get('db');
    const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.person_id !== req.user.person_id && req.user.role !== 'parent') {
      return res.status(403).json({ error: 'Not your assignment' });
    }
    const chore = db.prepare('SELECT anti_cheat FROM chores WHERE id = ?').get(a.chore_id);
    if (chore.anti_cheat !== 'honor') {
      return res.status(400).json({ error: 'Use /submit for photo/approval chores' });
    }
    db.prepare(`
      UPDATE assignments
      SET status = 'done', updated_at = datetime('now'), late = CASE WHEN due_date < date('now') THEN 1 ELSE 0 END
      WHERE id = ?
    `).run(req.params.id);
    res.json({ ok: true });
  });

  return r;
}
