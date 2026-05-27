import { fromIso, toIso, dayOfWeek } from './dates.js';
import { shouldRunOn } from './assignments.js';

/**
 * Compute the weekly points for a kid given a week-start ISO date.
 * Returns { totalWeight, doneWeight, percent, points }.
 *
 * Denominator (totalWeight): the full week (Mon-Sun). For each day:
 *   - If assignments are already materialized for this kid on that day,
 *     use those weights (counts own + stolen-away, excludes stolen-in
 *     since those are extra credit and live outside the baseline).
 *   - Otherwise, FORECAST from the chore library: for every recurring
 *     non-deleted chore whose default_assignees includes this kid, if
 *     the chore's recurrence would fire on that day, add its weight.
 *
 * Numerator (doneWeight): sum of weights of currently-theirs assignments
 * that are status='done'. Stolen-in done DOES count (pushes percent > 100).
 * Stolen-away done doesn't (someone else owns the row now).
 */
export function calcWeekPoints(db, personId, weekStartIso) {
  const start = fromIso(weekStartIso);

  // Numerator: actual done assignments owned by this kid this week.
  const doneRow = db.prepare(`
    SELECT COALESCE(SUM(c.weight), 0) AS w
    FROM assignments a
    JOIN chores c ON c.id = a.chore_id
    WHERE a.due_date BETWEEN ? AND date(?, '+6 days')
      AND a.person_id = ?
      AND a.status = 'done'
  `).get(weekStartIso, weekStartIso, personId);
  const doneWeight = doneRow.w;

  // Denominator: materialized for days that have any rows for this kid,
  // forecast for days that have none.
  const matRows = db.prepare(`
    SELECT a.due_date, c.weight
    FROM assignments a
    JOIN chores c ON c.id = a.chore_id
    WHERE a.due_date BETWEEN ? AND date(?, '+6 days')
      AND (
        (a.person_id = ? AND a.stolen_from IS NULL)
        OR a.stolen_from = ?
      )
  `).all(weekStartIso, weekStartIso, personId, personId);

  const materializedByDay = new Map();
  for (const r of matRows) {
    materializedByDay.set(r.due_date, (materializedByDay.get(r.due_date) || 0) + r.weight);
  }

  let totalWeight = 0;
  for (const w of materializedByDay.values()) totalWeight += w;

  // Forecast any of the seven week days that have no materialized rows.
  const chores = db.prepare(`
    SELECT * FROM chores
    WHERE kind = 'recurring' AND deleted_at IS NULL AND default_assignees != ''
  `).all();
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const iso = toIso(d);
    if (materializedByDay.has(iso)) continue;
    const dow = dayOfWeek(iso);
    for (const c of chores) {
      const assignees = c.default_assignees.split(',').map(s => parseInt(s, 10));
      if (!assignees.includes(personId)) continue;
      if (!shouldRunOn(c, iso, dow)) continue;
      totalWeight += c.weight;
    }
  }

  const person = db.prepare('SELECT weekly_target_pts FROM people WHERE id = ?').get(personId);
  const target = person?.weekly_target_pts || 0;

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
