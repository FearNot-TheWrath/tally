import { Router } from 'express';
import { requireRole } from '../../auth.js';
import { notifyWall } from '../../lib/events.js';

export function adminBankRoutes() {
  const r = Router();
  r.use(requireRole('parent'));

  r.get('/bank', (req, res) => {
    const db = req.app.get('db');
    const kids = db.prepare(
      "SELECT id, name, avatar_color, bank_cents FROM people WHERE role = 'kid' ORDER BY name"
    ).all();
    for (const kid of kids) {
      kid.transactions = db.prepare(
        "SELECT id, type, amount_cents, note, week_start, created_at FROM transactions WHERE person_id = ? ORDER BY created_at DESC LIMIT 20"
      ).all(kid.id);
    }
    res.json({ kids });
  });

  r.post('/bank/:personId/adjust', (req, res) => {
    const db = req.app.get('db');
    const personId = parseInt(req.params.personId, 10);
    const { amount_cents, note } = req.body || {};

    if (!Number.isFinite(amount_cents) || amount_cents === 0) {
      return res.status(400).json({ error: 'amount_cents must be a nonzero number' });
    }
    if (!note || !String(note).trim()) {
      return res.status(400).json({ error: 'note is required' });
    }

    const person = db.prepare("SELECT id, bank_cents FROM people WHERE id = ? AND role = 'kid'").get(personId);
    if (!person) return res.status(404).json({ error: 'Kid not found' });

    const txn = db.transaction(() => {
      const row = db.prepare(
        "INSERT INTO transactions (person_id, type, amount_cents, note) VALUES (?, 'adjustment', ?, ?) RETURNING *"
      ).get(personId, amount_cents, String(note).trim());
      db.prepare("UPDATE people SET bank_cents = bank_cents + ? WHERE id = ?").run(amount_cents, personId);
      const updated = db.prepare("SELECT bank_cents FROM people WHERE id = ?").get(personId);
      return { transaction: row, bank_cents: updated.bank_cents };
    });

    const result = txn();
    res.json({ ok: true, bank_cents: result.bank_cents, transaction: result.transaction });
    notifyWall();
  });

  return r;
}
