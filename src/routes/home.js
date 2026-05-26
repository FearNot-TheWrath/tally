import { Router } from 'express';
import multer from 'multer';
import { requireRole, requireAnyAuth } from '../auth.js';
import { today, weekStart } from '../lib/dates.js';
import { calcWeekPoints, calcProjectedPay } from '../lib/points.js';
import { savePhoto } from '../lib/photo.js';

export function homeRoutes({ uploadsDir = './uploads' } = {}) {
  const r = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  });

  r.get('/home', requireRole('kid'), (req, res) => {
    const db = req.app.get('db');
    const personId = req.user.person_id;
    const person = db.prepare(`
      SELECT id, name, avatar_color, weekly_target_pts, base_pay_cents, bonus_rate_cents,
             bank_cents, streak_days
      FROM people WHERE id = ?
    `).get(personId);

    const ws = weekStart(today());
    const pts = calcWeekPoints(db, personId, ws);
    person.points_this_week = pts.points;
    person.percent = pts.percent;
    person.projected_pay_cents = calcProjectedPay(person, pts.points);

    const assignments = db.prepare(`
      SELECT a.id, a.due_date, a.status, a.note, a.photo_path,
             a.stolen_from,
             c.title, c.weight, c.anti_cheat,
             sf.name AS stolen_from_name
      FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      LEFT JOIN people sf ON sf.id = a.stolen_from
      WHERE a.person_id = ?
        AND (a.due_date = ? OR (a.due_date < ? AND a.status NOT IN ('done','expired','rejected')))
      ORDER BY a.due_date, c.title
    `).all(personId, today(), today());

    const target = person.weekly_target_pts || 0;
    for (const a of assignments) {
      a.display_points = pts.totalWeight > 0
        ? Math.round(a.weight / pts.totalWeight * target)
        : 0;
    }

    const todayList = assignments.filter(a => a.due_date === today());
    const overdueList = assignments.filter(a => a.due_date !== today());
    res.json({ person, today: todayList, overdue: overdueList });
  });

  // Backward-compat for honor chores; /submit is preferred.
  r.post('/assignments/:id/done', requireAnyAuth, (req, res) => {
    return doSubmit(req, res, { honorOnly: true });
  });

  r.post('/assignments/:id/submit', requireAnyAuth, upload.single('photo'), (req, res) => {
    return doSubmit(req, res, { uploadsDir });
  });

  r.post('/assignments/:id/undo', requireAnyAuth, (req, res) => {
    const db = req.app.get('db');
    const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.person_id !== req.user.person_id && req.user.role !== 'parent') {
      return res.status(403).json({ error: 'Not your assignment' });
    }
    const chore = db.prepare('SELECT anti_cheat FROM chores WHERE id = ?').get(a.chore_id);
    if (chore.anti_cheat !== 'honor') {
      return res.status(400).json({ error: 'Undo only works on honor chores' });
    }
    if (a.status !== 'done') {
      return res.status(400).json({ error: 'Assignment is not done; nothing to undo' });
    }
    db.prepare(`
      UPDATE assignments
      SET status = 'pending',
          points_earned = 0,
          late = 0,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(req.params.id);
    res.json({ ok: true, status: 'pending' });
  });

  return r;
}

function doSubmit(req, res, { honorOnly = false, uploadsDir = './uploads' } = {}) {
  const db = req.app.get('db');
  const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (a.person_id !== req.user.person_id && req.user.role !== 'parent') {
    return res.status(403).json({ error: 'Not your assignment' });
  }
  const chore = db.prepare('SELECT anti_cheat, points FROM chores WHERE id = ?').get(a.chore_id);
  if (honorOnly && chore.anti_cheat !== 'honor') {
    return res.status(400).json({ error: 'Use /submit for photo/approval chores' });
  }

  if (chore.anti_cheat === 'honor') {
    db.prepare(`
      UPDATE assignments
      SET status = 'done',
          updated_at = datetime('now'),
          late = CASE WHEN due_date < date('now') THEN 1 ELSE 0 END,
          points_earned = ?
      WHERE id = ?
    `).run(chore.points, req.params.id);
    return res.json({ ok: true, status: 'done' });
  }

  if (chore.anti_cheat === 'approval') {
    db.prepare(`
      UPDATE assignments
      SET status = 'submitted', submitted_at = datetime('now'),
          note = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(req.body?.note || '', req.params.id);
    return res.json({ ok: true, status: 'submitted' });
  }

  // anti_cheat === 'photo'
  if (!req.file) return res.status(400).json({ error: 'Photo required for this chore' });
  return savePhoto(req.file.buffer, Number(req.params.id), uploadsDir)
    .then(absPath => {
      db.prepare(`
        UPDATE assignments
        SET status = 'submitted', submitted_at = datetime('now'),
            photo_path = ?, note = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(absPath, req.body?.note || '', req.params.id);
      res.json({ ok: true, status: 'submitted' });
    })
    .catch(err => res.status(400).json({ error: err.message }));
}
