import { Router } from 'express';
import { unlinkSync } from 'node:fs';
import multer from 'multer';
import { requireRole, requireAnyAuth } from '../auth.js';
import { today, weekStart } from '../lib/dates.js';
import { calcWeekPoints, calcProjectedPay } from '../lib/points.js';
import { savePhoto } from '../lib/photo.js';
import { currentStreak, streakAtRisk, isOnFreeze } from '../lib/streak.js';
import { notifyWall } from '../lib/events.js';
import { runPayoutIfDue } from '../lib/payout.js';

export function homeRoutes({ uploadsDir = './uploads' } = {}) {
  const r = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  });

  r.get('/home', requireRole('kid'), (req, res) => {
    const db = req.app.get('db');
    runPayoutIfDue(db);
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

    person.transactions = db.prepare(
      "SELECT id, type, amount_cents, note, created_at FROM transactions WHERE person_id = ? ORDER BY created_at DESC LIMIT 10"
    ).all(personId);

    const assignments = db.prepare(`
      SELECT a.id, a.due_date, a.status, a.note, a.photo_path,
             a.stolen_from,
             c.title, c.weight, c.anti_cheat, c.kind, c.points AS chore_points,
             sf.name AS stolen_from_name
      FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      LEFT JOIN people sf ON sf.id = a.stolen_from
      WHERE a.person_id = ?
        AND (a.due_date = ? OR (a.due_date < ? AND a.status NOT IN ('done','expired','rejected','excused')))
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
        AND c.unstealable = 0
      ORDER BY p.name, c.title
    `).all(today(), personId) : [];
    for (const s of stealable) {
      s.display_points = pts.totalWeight > 0
        ? Math.round(s.weight / pts.totalWeight * target)
        : 0;
    }

    const coverRows = db.prepare(`
      SELECT a.id, a.person_id AS owner_id, a.due_date,
             c.title, c.weight, c.anti_cheat,
             p.name AS owner_name, p.avatar_color AS owner_color
      FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      JOIN people p ON p.id = a.person_id
      WHERE a.status = 'excused'
        AND a.person_id != ?
        AND p.role = 'kid'
        AND c.kind != 'bonus'
      ORDER BY p.name, c.title
    `).all(personId);
    const covers = coverRows
      .filter(r => isOnFreeze(db, r.owner_id, r.due_date))
      .map(r => ({
        id: r.id,
        title: r.title,
        weight: r.weight,
        anti_cheat: r.anti_cheat,
        owner_id: r.owner_id,
        owner_name: r.owner_name,
        owner_color: r.owner_color,
        display_points: pts.totalWeight > 0
          ? Math.round(r.weight / pts.totalWeight * target)
          : 0,
      }));

    const todayList = assignments.filter(a => a.due_date === today());
    const overdueList = assignments.filter(a => a.due_date !== today());

    const bonuses = db.prepare(`
      SELECT c.id, c.title, c.description, c.points, c.anti_cheat, c.photo_prompt
      FROM chores c
      LEFT JOIN assignments a ON a.chore_id = c.id
      WHERE c.kind = 'bonus' AND c.deleted_at IS NULL AND a.id IS NULL
      ORDER BY c.created_at DESC
    `).all();

    res.json({ person, today: todayList, overdue: overdueList, stealable, bonuses, covers });
  });

  // Backward-compat for honor chores; /submit is preferred.
  r.post('/assignments/:id/done', requireAnyAuth, (req, res) => {
    return doSubmit(req, res, { honorOnly: true });
  });

  r.post('/assignments/:id/submit', requireAnyAuth, upload.array('photo', 3), (req, res) => {
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
    notifyWall();
  });

  r.post('/assignments/:id/steal', requireRole('kid'), (req, res) => {
    const db = req.app.get('db');
    const stealerId = req.user.person_id;
    const a = db.prepare(`
      SELECT a.*, c.unstealable
      FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      WHERE a.id = ?
    `).get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.person_id === stealerId) return res.status(403).json({ error: 'Cannot steal from yourself' });
    if (a.unstealable) return res.status(400).json({ error: 'This chore cannot be stolen' });
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
    notifyWall();
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
    notifyWall();
  });

  r.post('/assignments/:id/unclaim', requireRole('kid'), (req, res) => {
    const db = req.app.get('db');
    const kidId = req.user.person_id;
    const a = db.prepare(`
      SELECT a.id, a.person_id, a.status, c.kind
      FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      WHERE a.id = ?
    `).get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.person_id !== kidId) return res.status(403).json({ error: 'Not your bonus' });
    if (a.kind !== 'bonus') return res.status(409).json({ error: 'Only bonus chores can be given back' });
    if (a.status !== 'pending') return res.status(409).json({ error: 'Can only give back a bonus before starting it' });
    db.prepare('DELETE FROM assignments WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
    notifyWall();
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
    res.json({ ok: true, status: 'done' });
    notifyWall();
    return;
  }

  if (chore.anti_cheat === 'approval') {
    db.prepare(`
      UPDATE assignments
      SET status = 'submitted', submitted_at = datetime('now'),
          note = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(req.body?.note || '', req.params.id);
    res.json({ ok: true, status: 'submitted' });
    notifyWall();
    return;
  }

  // anti_cheat === 'photo'
  const files = req.files || [];
  if (files.length === 0) return res.status(400).json({ error: 'At least one photo is required' });

  // Clear any prior photos for this assignment (re-submit after a reject).
  const prior = db.prepare('SELECT path FROM assignment_photos WHERE assignment_id = ?').all(req.params.id);
  for (const p of prior) { try { unlinkSync(p.path); } catch { /* gone already */ } }
  db.prepare('DELETE FROM assignment_photos WHERE assignment_id = ?').run(req.params.id);

  return Promise.all(files.map((f, i) => savePhoto(f.buffer, Number(req.params.id), uploadsDir, i + 1)))
    .then(paths => {
      const ins = db.prepare('INSERT INTO assignment_photos (assignment_id, path) VALUES (?, ?)');
      for (const p of paths) ins.run(req.params.id, p);
      db.prepare(`
        UPDATE assignments
        SET status = 'submitted', submitted_at = datetime('now'),
            note = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(req.body?.note || '', req.params.id);
      res.json({ ok: true, status: 'submitted' });
      notifyWall();
    })
    .catch(err => res.status(400).json({ error: err.message }));
}
