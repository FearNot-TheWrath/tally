import { Router } from 'express';
import { requireRole } from '../auth.js';
import { isPushConfigured, getPublicKey, saveSubscription, removeSubscription } from '../lib/push.js';

export function pushRoutes() {
  const r = Router();
  const kidOnly = requireRole('kid');

  r.get('/push/vapid-key', kidOnly, (req, res) => {
    if (!isPushConfigured()) return res.status(503).json({ error: 'Push not configured' });
    res.json({ key: getPublicKey() });
  });

  r.post('/push/subscribe', kidOnly, (req, res) => {
    const db = req.app.get('db');
    const sub = req.body || {};
    if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    saveSubscription(db, req.user.person_id, sub);
    res.json({ ok: true });
  });

  r.post('/push/unsubscribe', kidOnly, (req, res) => {
    const db = req.app.get('db');
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
    removeSubscription(db, endpoint);
    res.json({ ok: true });
  });

  return r;
}
