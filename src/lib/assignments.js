import { today, dayOfWeek, weekStart, fromIso } from './dates.js';

export function generateForToday(db, date = today()) {
  const dow = dayOfWeek(date);
  const chores = db.prepare(`
    SELECT * FROM chores
    WHERE kind = 'recurring' AND deleted_at IS NULL AND default_assignees != ''
  `).all();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO assignments (chore_id, person_id, due_date, status)
    VALUES (?, ?, ?, 'pending')
  `);

  const tx = db.transaction((rows) => {
    for (const c of rows) {
      if (!shouldRunOn(c, date, dow)) continue;
      const assignees = c.default_assignees.split(',').map(s => parseInt(s, 10)).filter(Boolean);
      for (const personId of assignees) {
        insert.run(c.id, personId, date);
      }
    }
  });
  tx(chores);
}

export function shouldRunOn(chore, isoDate, dow) {
  switch (chore.recurs) {
    case 'daily':
      return true;
    case 'weekly': {
      if (!chore.recurs_days) return true;
      const days = chore.recurs_days.split(',').map(Number);
      return days.includes(dow);
    }
    case 'biweekly': {
      if (chore.recurs_days) {
        const days = chore.recurs_days.split(',').map(Number);
        if (!days.includes(dow)) return false;
      }
      const anchor = chore.recurs_anchor || isoDate;
      const weeks = Math.floor((fromIso(isoDate) - fromIso(weekStart(anchor))) / (1000 * 60 * 60 * 24 * 7));
      return weeks % 2 === 0;
    }
    case 'monthly':
      return fromIso(isoDate).getDate() === fromIso(chore.recurs_anchor || isoDate).getDate();
    default:
      return false;
  }
}
