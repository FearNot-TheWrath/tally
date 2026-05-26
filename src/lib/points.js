import { weekStart, fromIso, toIso } from './dates.js';

/**
 * Compute the weekly points for a kid given a week-start ISO date.
 * Returns { totalWeight, doneWeight, percent, points }.
 *
 * Denominator (totalWeight) = sum of weights of chores currently theirs
 * (and never stolen) PLUS chores stolen FROM them. They're on the hook
 * for everything originally assigned.
 *
 * Numerator (doneWeight) = sum of weights of chores currently theirs
 * AND done. Stolen-in done chores count; stolen-away done chores don't
 * (because the row's person_id is now the stealer's, not the original's).
 */
export function calcWeekPoints(db, personId, weekStartIso) {
  const start = fromIso(weekStartIso);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const startStr = weekStartIso;
  const endStr = toIso(end);

  const totalRow = db.prepare(`
    SELECT COALESCE(SUM(c.weight), 0) AS w
    FROM assignments a
    JOIN chores c ON c.id = a.chore_id
    WHERE a.due_date BETWEEN ? AND ?
      AND (
        (a.person_id = ? AND a.stolen_from IS NULL)
        OR a.stolen_from = ?
      )
  `).get(startStr, endStr, personId, personId);

  const doneRow = db.prepare(`
    SELECT COALESCE(SUM(c.weight), 0) AS w
    FROM assignments a
    JOIN chores c ON c.id = a.chore_id
    WHERE a.due_date BETWEEN ? AND ?
      AND a.person_id = ?
      AND a.status = 'done'
  `).get(startStr, endStr, personId);

  const person = db.prepare('SELECT weekly_target_pts FROM people WHERE id = ?').get(personId);
  const target = person?.weekly_target_pts || 0;

  const totalWeight = totalRow.w;
  const doneWeight = doneRow.w;
  const percent = totalWeight === 0 ? 0 : doneWeight / totalWeight;
  const points = Math.round(percent * target);

  return { totalWeight, doneWeight, percent, points };
}

/**
 * Given a `people` row and a points count, return projected weekly pay in cents.
 * - Base: linear from 0 up to base_pay_cents at 100% of target.
 * - Bonus: bonus_rate_cents per point earned over target.
 */
export function calcProjectedPay(person, points) {
  const target = person.weekly_target_pts || 0;
  const base = person.base_pay_cents || 0;
  const bonusRate = person.bonus_rate_cents || 0;
  if (target === 0) return 0;
  const cappedPct = Math.min(points / target, 1.0);
  const basePart = Math.round(cappedPct * base);
  const extraPoints = Math.max(0, points - target);
  const bonusPart = extraPoints * bonusRate;
  return basePart + bonusPart;
}
