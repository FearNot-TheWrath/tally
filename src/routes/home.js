import { Router } from 'express';
import multer from 'multer';
import { requireRole, requireAnyAuth } from '../auth.js';
import { today, weekStart } from '../lib/dates.js';
import { calcWeekPoints, calcProjectedPay } from '../lib/points.js';
import { savePhoto } from '../lib/photo.js';
import { currentStreak, streakAtRisk, isOnFreeze } from '../lib/streak.js';

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
    person.weighted_points = pts.weightedPoints;
    person.bonus_points_this_week = pts.bonusPoints;
    person.projected_pay_cents = calcProjectedPay(person, pts.points);

    const streakDays = currentStreak(db, personId);
    const warningRow = db.prepare("SELECT value FROM settings WHERE key='streak_warning_time'").get();
    const warningTime = warningRow ? warningRow.value : '20:00';
    person.streak_days = streakDays;
    person.streak_at_risk = streakAtRisk(db, personId, warningTime, streakDays);
    person.on_freeze = isOnFreeze(db, personId);

    const assignments = db.prepare(`
      SELECT a.id, a.due_date, a.status, a.note, a.photo_path,
             a.stolen_from,
             c.title, c.weight, c.anti_cheat, c.kind, c.points AS chore_points,
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
      if (a.kind === 'bonus') {
        a.display_points = a.chore_points;
        a.is_bonus = 1;
      } else {
        a.display_points = pts.totalWeight > 0
          ? Math.round(a.weight / pts.totalWeight * target)
          : 0;
        a.is_bonus = 0;
      }
    }

    const stealable = isUnlocked(db) ? db.prepare(`
      SELECT a.id, c.title, c.weight, c.anti_cheat,
             a.person_id AS owner_id,
             p.name AS owner_name,
             p.avatar_color AS owner_color
      FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      JOIN people p ON p.id = a.person_id
      WHERE a.due_date = ?
        AND a.status = 'pending'
        AND a.person_id != ?
        AND p.role = 'kid'
        AND c.is_school_work = 0
      ORDER BY p.name, c.title
    `).all(today(), personId) : [];
    for (const s of stealable) {
      s.display_points = pts.totalWeight > 0
        ? Math.round(s.weight / pts.totalWeight * target)
        : 0;
    }

    const todayList = assignments.filter(a => a.due_date === today());
    const overdueList = assignments.filter(a => a.due_date !== today());

    const bonuses = db.prepare(`
      SELECT c.id, c.title, c.description, c.points, c.anti_cheat, c.photo_prompt
      FROM chores c
      LEFT JOIN assignments a ON a.chore_id = c.id
      WHERE c.kind = 'bonus' AND c.deleted_at IS NULL AND a.id IS NULL
      ORDER BY c.created_at DESC
    `).all();

    res.json({ person, today: todayList, overdue: overdueList, stealable, bonuses });
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

  r.post('/assignments/:id/steal', requireRole('kid'), (req, res) => {
    const db = req.app.get('db');
    const stealerId = req.user.person_id;
    const a = db.prepare(`
      SELECT a.*, c.is_school_work
      FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      WHERE a.id = ?
    `).get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.person_id === stealerId) return res.status(403).json({ error: 'Cannot steal from yourself' });
    if (a.is_school_work) return res.status(400).json({ error: 'School work cannot be stolen' });
    if (a.status !== 'pending') return res.status(400).json({ error: 'Only pending chores can be stolen' });
    if (a.due_date !== today()) return res.status(400).json({ error: "Only today's chores can be stolen" });
    if (!isUnlocked(db)) return res.status(400).json({ error: 'Stealing is not yet unlocked today' });

    const result = db.prepare(`
      UPDATE assignments
      SET person_id = ?, stolen_from = ?, updated_at = datetime('now')
      WHERE id = ?
        AND status = 'pending'
        AND person_id = ?
    `).run(stealerId, a.person_id, req.params.id, a.person_id);

    if (result.changes === 0) {
      return res.status(409).json({ error: 'Already claimed or no longer pending' });
    }
    res.json({ ok: true });
  });

  r.post('/bonuses/:id/claim', requireRole('kid'), (req, res) => {
    const db = req.app.get('db');
    const kidId = req.user.person_id;
    const chore = db.prepare(
      "SELECT * FROM chores WHERE id = ? AND kind = 'bonus' AND deleted_at IS NULL"
    ).get(req.params.id);
    if (!chore) return res.status(404).json({ error: 'Not found' });

    const row = db.prepare(`
      INSERT INTO assignments (chore_id, person_id, due_date, status)
      SELECT ?, ?, date('now', 'localtime'), 'pending'
      WHERE NOT EXISTS (SELECT 1 FROM assignments WHERE chore_id = ?)
      RETURNING id
    `).get(chore.id, kidId, chore.id);

    if (!row) {
      return res.status(409).json({ error: 'Already claimed' });
    }
    res.json({ ok: true, assignment_id: row.id });
  });

  return r;
}

function isUnlocked(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'steal_unlock_time'").get();
  if (!row) return false;
  const [hh, mm] = row.value.split(':').map(Number);
  const now = new Date();
  const cutoff = new Date();
  cutoff.setHours(hh, mm, 0, 0);
  return now >= cutoff;
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
