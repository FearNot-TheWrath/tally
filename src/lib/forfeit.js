import { today } from './dates.js';

let lastCheck = 0;

export function _resetCache() {
  lastCheck = 0;
}

export function sweepForfeits(db) {
  const now = Date.now();
  if (now - lastCheck < 60_000) return;
  lastCheck = now;

  const row = db.prepare("SELECT value FROM settings WHERE key = 'school_deadline_time'").get();
  const deadline = (row && row.value) ? row.value : '16:00';
  const [hh, mm] = deadline.split(':').map(Number);

  const t = today();
  const nowDate = new Date();
  const cutoff = new Date();
  cutoff.setHours(hh, mm, 0, 0);
  const pastTodaysCutoff = nowDate >= cutoff;

  if (pastTodaysCutoff) {
    db.prepare(`
      UPDATE assignments
      SET forfeited = 1, updated_at = datetime('now')
      WHERE forfeited = 0
        AND status != 'done'
        AND due_date <= ?
        AND chore_id IN (SELECT id FROM chores WHERE is_school_work = 1)
    `).run(t);
  } else {
    db.prepare(`
      UPDATE assignments
      SET forfeited = 1, updated_at = datetime('now')
      WHERE forfeited = 0
        AND status != 'done'
        AND due_date < ?
        AND chore_id IN (SELECT id FROM chores WHERE is_school_work = 1)
    `).run(t);
  }
}
