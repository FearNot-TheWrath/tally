import { Router } from 'express';
import { existsSync, statSync, createReadStream, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { requireRole, requireAnyAuth } from '../../auth.js';
import { notifyWall } from '../../lib/events.js';

export function adminApprovalsRoutes() {
  const r = Router();
  r.use(requireRole('parent'));

  r.get('/approvals', (req, res) => {
    const db = req.app.get('db');
    const rows = db.prepare(`
      SELECT a.id, a.note, a.photo_path, a.submitted_at, a.due_date,
             c.title AS chore_title, c.points AS chore_points, c.anti_cheat,
             p.id AS kid_id, p.name AS kid_name, p.avatar_color AS kid_color
      FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      JOIN people p ON p.id = a.person_id
      WHERE a.status = 'submitted'
      ORDER BY a.submitted_at ASC
    `).all();
    const items = rows.map(row => ({
      ...row,
      photos: db.prepare('SELECT path FROM assignment_photos WHERE assignment_id = ? ORDER BY id').all(row.id)
        .map(p => `/api/uploads/${relFromUploads(p.path)}`),
    }));
    res.json({ approvals: items });
  });

  r.post('/approvals/:id/approve', (req, res) => {
    const db = req.app.get('db');
    const a = db.prepare('SELECT * FROM assignments WHERE id = ? AND status = ?').get(req.params.id, 'submitted');
    if (!a) return res.status(404).json({ error: 'Not found or not pending' });
    const chore = db.prepare('SELECT points FROM chores WHERE id = ?').get(a.chore_id);
    const points = Number.isFinite(req.body?.points) ? req.body.points : chore.points;
    deleteAllPhotos(db, a.id);
    db.prepare(`
      UPDATE assignments
      SET status = 'done',
          approved_at = datetime('now'),
          approved_by = ?,
          points_earned = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(req.user.person_id, points, req.params.id);
    res.json({ ok: true });
    notifyWall();
  });

  r.post('/approvals/:id/reject', (req, res) => {
    const db = req.app.get('db');
    const a = db.prepare('SELECT * FROM assignments WHERE id = ? AND status = ?').get(req.params.id, 'submitted');
    if (!a) return res.status(404).json({ error: 'Not found or not pending' });
    deleteAllPhotos(db, a.id);
    db.prepare(`
      UPDATE assignments
      SET status = 'pending',
          note = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(req.body?.note || '', req.params.id);
    res.json({ ok: true });
    notifyWall();
  });

  return r;
}

function deleteAllPhotos(db, assignmentId) {
  const rows = db.prepare('SELECT path FROM assignment_photos WHERE assignment_id = ?').all(assignmentId);
  for (const r of rows) { try { unlinkSync(r.path); } catch { /* gone */ } }
  db.prepare('DELETE FROM assignment_photos WHERE assignment_id = ?').run(assignmentId);
}

function relFromUploads(absPath) {
  const i = absPath.indexOf('uploads/');
  if (i === -1) return absPath.split(/[/\\]/).pop();
  return absPath.slice(i + 'uploads/'.length);
}

export function uploadsRoute() {
  const r = Router();
  r.get('/uploads/:yearMonth/:file', requireAnyAuth, (req, res) => {
    const db = req.app.get('db');
    const uploadsDir = req.app.get('uploadsDir') || './uploads';
    const { yearMonth, file } = req.params;
    if (!/^\d{4}-\d{2}$/.test(yearMonth)) return res.status(400).json({ error: 'bad path' });
    // Filenames are `${assignmentId}.jpg` (legacy) or `${assignmentId}-${slot}.jpg` (multi-photo).
    if (!/^\d+(-\d+)?\.jpg$/.test(file)) return res.status(400).json({ error: 'bad path' });

    const assignmentId = Number(file.replace('.jpg', '').split('-')[0]);
    const row = db.prepare('SELECT person_id FROM assignments WHERE id = ?').get(assignmentId);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const isOwner = row.person_id === req.user.person_id;
    const isParent = req.user.role === 'parent';
    if (!isOwner && !isParent) return res.status(403).json({ error: 'Forbidden' });

    const fullPath = resolve(uploadsDir, yearMonth, file);
    if (!existsSync(fullPath)) return res.status(404).json({ error: 'Photo missing' });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Length', statSync(fullPath).size);
    createReadStream(fullPath).pipe(res);
  });
  return r;
}
