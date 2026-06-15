import { Router } from 'express';
import { requireRole } from '../../auth.js';
import { notifyWall } from '../../lib/events.js';

export function adminAssignmentsRoutes() {
  const r = Router();
  r.use(requireRole('parent'));

  r.post('/assignments/:id/excuse', (req, res) => {
    const db = req.app.get('db');
    const id = parseInt(req.params.id, 10);
    const note = (req.body?.note && String(req.body.note).trim()) || 'Excused by parent';
    const a = db.prepare(`
      SELECT a.id FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      WHERE a.id = ? AND c.kind != 'bonus'
    `).get(id);
    if (!a) return res.status(400).json({ error: 'Assignment not found or is a bonus' });
    db.prepare("UPDATE assignments SET status = 'excused', note = ? WHERE id = ?").run(note, id);
    res.json({ ok: true });
    notifyWall();
  });

  r.post('/assignments/bulk-excuse', (req, res) => {
    const db = req.app.get('db');
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map(n => parseInt(n, 10)).filter(Number.isInteger)
      : [];
    if (ids.length === 0) return res.status(400).json({ error: 'ids[] required' });
    const note = (req.body?.note && String(req.body.note).trim()) || 'Excused by parent';
    const placeholders = ids.map(() => '?').join(',');
    const valid = db.prepare(`
      SELECT a.id FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      WHERE c.kind != 'bonus' AND a.id IN (${placeholders})
    `).all(...ids);
    if (valid.length === 0) return res.status(400).json({ error: 'no valid assignments' });
    const upd = db.prepare(`UPDATE assignments SET status = 'excused', note = ? WHERE id = ?`);
    const tx = db.transaction(() => { for (const v of valid) upd.run(note, v.id); });
    tx();
    res.json({ ok: true, excused: valid.length });
    notifyWall();
  });

  r.post('/assignments/:id/unexcuse', (req, res) => {
    const db = req.app.get('db');
    const id = parseInt(req.params.id, 10);
    const a = db.prepare("SELECT status FROM assignments WHERE id = ?").get(id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.status !== 'excused') return res.status(409).json({ error: 'Not excused' });
    db.prepare("UPDATE assignments SET status = 'pending', note = '' WHERE id = ?").run(id);
    res.json({ ok: true });
    notifyWall();
  });

  return r;
}
