import { fromIso, toIso, dayOfWeek } from './dates.js';
import { shouldRunOn } from './assignments.js';

/**
 * Compute the weekly points for a kid given a week-start ISO date.
 * Returns { totalWeight, doneWeight, weightedPercent, weightedPoints,
 *           bonusPoints, points, percent }.
 *
 * weightedPoints comes from the standard weight ratio across the kid's
 * baseline chores (forecast included). bonusPoints comes from completed
 * bonus chores (chores.kind = 'bonus') in this week. The returned `points`
 * is the sum and is what the UI displays. `percent` = points / target,
 * which can exceed 1.0 when stolen-in or bonus chores push past target.
 */
export function calcWeekPoints(db, personId, weekStartIso) {
  const start = fromIso(weekStartIso);

  // Numerator from weight: done assignments currently owned by this kid this week,
  // excluding bonus chores (those are tracked separately in bonusPoints).
  const doneRow = db.prepare(`
    SELECT COALESCE(SUM(c.weight), 0) AS w
    FROM assignments a
    JOIN chores c ON c.id = a.chore_id
    WHERE a.due_date BETWEEN ? AND date(?, '+6 days')
      AND a.person_id = ?
      AND a.status = 'done'
      AND c.kind != 'bonus'
  `).get(weekStartIso, weekStartIso, personId);
  const doneWeight = doneRow.w;

  // Denominator: materialized for days with rows, forecast for the rest.
  // Bonus chores never enter the denominator.
  const matRows = db.prepare(`
    SELECT a.due_date, c.weight
    FROM assignments a
    JOIN chores c ON c.id = a.chore_id
    WHERE a.due_date BETWEEN ? AND date(?, '+6 days')
      AND c.kind != 'bonus'
      AND a.status != 'excused'
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

  // Bonus points: sum of done bonus-chore point values this week.
  const bonusRow = db.prepare(`
    SELECT COALESCE(SUM(c.points), 0) AS p
    FROM assignments a
    JOIN chores c ON c.id = a.chore_id
    WHERE a.due_date BETWEEN ? AND date(?, '+6 days')
      AND a.person_id = ?
      AND a.status = 'done'
      AND c.kind = 'bonus'
  `).get(weekStartIso, weekStartIso, personId);
  const bonusPoints = bonusRow.p;

  const person = db.prepare('SELECT weekly_target_pts FROM people WHERE id = ?').get(personId);
  const target = person?.weekly_target_pts || 0;

  const weightedPercent = totalWeight === 0 ? 0 : doneWeight / totalWeight;
  const weightedPoints = Math.round(weightedPercent * target);
  const points = weightedPoints + bonusPoints;
  const percent = target === 0 ? 0 : points / target;

  return {
    totalWeight,
    doneWeight,
    weightedPercent,
    weightedPoints,
    bonusPoints,
    points,
    percent,
  };
}

/**
 * Given a `people` row and a points count, return projected weekly pay in cents.
 * Two buckets:
 *   1. base_part: linear from 0 up to base_pay_cents at 100% of target (capped at 100%)
 *   2. bonus_part: bonus_rate_cents per point earned over target
 * Callers should pass weightedPoints + bonusPoints as `points`. Anything past
 * target (whether from stolen-in chores or bonus chores) flows through the
 * same bonus_rate.
 */
export function calcProjectedPay(person, points) {
  const target = person.weekly_target_pts || 0;
  const base = person.base_pay_cents || 0;
  const bonusRate = person.bonus_rate_cents || 0;
  if (target === 0) return 0;
  const cappedPts = Math.min(points, target);
  const basePart = Math.round((cappedPts / target) * base);
  const extraPoints = Math.max(0, points - target);
  const bonusPart = extraPoints * bonusRate;
  return basePart + bonusPart;
}
