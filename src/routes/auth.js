import { Router } from 'express';
import { createSession, destroySession, currentUser, verifyParentPin } from '../auth.js';

export function authRoutes() {
  const r = Router();

  r.get('/picker', (req, res) => {
    const db = req.app.get('db');
    const people = db.prepare(`
      SELECT id, name, role, avatar_color
      FROM people
      WHERE role IN ('kid','parent')
      ORDER BY role DESC, name
    `).all();
    res.json({ people });
  });

  r.post('/login', (req, res) => {
    const db = req.app.get('db');
    const { person_id, pin } = req.body || {};
    const person = db.prepare('SELECT * FROM people WHERE id = ?').get(person_id);
    if (!person || person.role === 'wall') {
      return res.status(404).json({ error: 'No such person' });
    }
    if (person.role === 'parent') {
      if (!pin || !verifyParentPin(db, pin)) {
        return res.status(401).json({ error: 'Wrong PIN' });
      }
    }
    const token = createSession(db, person.id, { ua: req.get('user-agent') || '' });
    req.session.token = token;
    res.json({ ok: true, person: { id: person.id, name: person.name, role: person.role } });
  });

  r.post('/logout', (req, res) => {
    const db = req.app.get('db');
    destroySession(db, req.session?.token);
    req.session = null;
    res.json({ ok: true });
  });

  return r;
}

export function meRoute() {
  const r = Router();
  r.get('/me', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    res.json({ id: user.person_id, name: user.name, role: user.role });
  });
  return r;
}
