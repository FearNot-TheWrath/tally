import { today } from './dates.js';

export function applyFreezeSweep(db, personId) {
  const person = db.prepare(
    'SELECT freeze_start, freeze_end FROM people WHERE id = ?'
  ).get(personId);
  if (!person || !person.freeze_start || !person.freeze_end) return;

  const t = today();
  const windowStart = person.freeze_start > t ? person.freeze_start : t;
  const windowEnd = person.freeze_end;
  if (windowEnd < windowStart) return;

  db.prepare(`
    UPDATE assignments
    SET status = 'excused',
        note = 'On freeze',
        updated_at = datetime('now')
    WHERE person_id = ?
      AND status = 'pending'
      AND due_date BETWEEN ? AND ?
      AND chore_id IN (SELECT id FROM chores WHERE kind != 'bonus')
  `).run(personId, windowStart, windowEnd);
}
