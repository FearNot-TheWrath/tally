import { today, toIso, fromIso } from './dates.js';

const MAX_WALK = 1000;

export function currentStreak(db, personId) {
  const person = db.prepare(
    'SELECT freeze_start, freeze_end FROM people WHERE id = ?'
  ).get(personId);
  if (!person) return 0;

  const firstRow = db.prepare(
    'SELECT MIN(due_date) AS d FROM assignments WHERE person_id = ?'
  ).get(personId);
  const firstAssignmentDate = firstRow?.d;
  if (!firstAssignmentDate) return 0;

  let count = 0;
  let date = today();
  let isToday = true;

  for (let i = 0; i < MAX_WALK; i++) {
    if (date < firstAssignmentDate) break;

    if (inFreezeRange(date, person.freeze_start, person.freeze_end)) {
      date = prevDay(date);
      isToday = false;
      continue;
    }

    if (dayQualifies(db, personId, date)) {
      count++;
      date = prevDay(date);
      isToday = false;
      continue;
    }

    if (isToday) {
      date = prevDay(date);
      isToday = false;
      continue;
    }

    break;
  }

  return count;
}

export function isOnFreeze(db, personId, dateIso = today()) {
  const person = db.prepare(
    'SELECT freeze_start, freeze_end FROM people WHERE id = ?'
  ).get(personId);
  if (!person) return false;
  return inFreezeRange(dateIso, person.freeze_start, person.freeze_end);
}

export function streakAtRisk(db, personId, warningTime, currentStreakValue) {
  if (!currentStreakValue || currentStreakValue <= 0) return false;
  if (!warningTime || !/^\d{2}:\d{2}$/.test(warningTime)) return false;
  const now = new Date();
  const [wh, wm] = warningTime.split(':').map(Number);
  const cutoff = new Date();
  cutoff.setHours(wh, wm, 0, 0);
  if (now < cutoff) return false;

  if (isOnFreeze(db, personId)) return false;

  const row = db.prepare(`
    SELECT 1
    FROM assignments a
    JOIN chores c ON c.id = a.chore_id
    WHERE a.person_id = ?
      AND a.due_date = ?
      AND a.status != 'done'
      AND a.status != 'excused'
      AND c.kind != 'bonus'
    LIMIT 1
  `).get(personId, today());
  return !!row;
}

function dayQualifies(db, personId, dateIso) {
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN a.status = 'done' THEN 1 ELSE 0 END), 0) AS done
    FROM assignments a
    JOIN chores c ON c.id = a.chore_id
    WHERE a.person_id = ? AND a.due_date = ? AND c.kind != 'bonus' AND a.status != 'excused'
  `).get(personId, dateIso);
  return row.total === row.done;
}

function inFreezeRange(dateIso, startIso, endIso) {
  if (!startIso || !endIso) return false;
  return dateIso >= startIso && dateIso <= endIso;
}

function prevDay(dateIso) {
  const d = fromIso(dateIso);
  d.setDate(d.getDate() - 1);
  return toIso(d);
}
