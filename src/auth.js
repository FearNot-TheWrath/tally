import { randomBytes } from 'node:crypto';
import { verifyPin } from './lib/scrypt.js';

export function createSession(db, personId, { ua = '', deviceFp = '' } = {}) {
  const token = randomBytes(24).toString('hex');
  db.prepare(`
    INSERT INTO sessions (id, person_id, user_agent, device_fp)
    VALUES (?, ?, ?, ?)
  `).run(token, personId, ua, deviceFp);
  return token;
}

export function getSession(db, token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT s.id, s.person_id, s.last_seen, p.role, p.name
    FROM sessions s JOIN people p ON p.id = s.person_id
    WHERE s.id = ?
  `).get(token);
  if (!row) return null;
  db.prepare('UPDATE sessions SET last_seen = datetime(\'now\') WHERE id = ?').run(token);
  return row;
}

export function destroySession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
}

export function verifyParentPin(db, pin) {
  const row = db.prepare("SELECT value FROM settings WHERE key='admin_pin_hash'").get();
  if (!row) return false;
  try { return verifyPin(pin, row.value); }
  catch { return false; }
}

export function currentUser(req) {
  const db = req.app.get('db');
  const token = req.session?.token;
  return getSession(db, token);
}

export function requireRole(role) {
  return (req, res, next) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    if (user.role !== role) return res.status(403).json({ error: 'Forbidden' });
    req.user = user;
    next();
  };
}

export function requireAnyAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  next();
}
