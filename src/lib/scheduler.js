import { today } from './dates.js';
import { currentStreak, streakAtRisk } from './streak.js';
import { sendToPerson } from './push.js';

export function streakReminderDue(db) {
  const warningRow = db.prepare("SELECT value FROM settings WHERE key='streak_warning_time'").get();
  const warningTime = warningRow ? warningRow.value : '20:00';
  const kids = db.prepare("SELECT id FROM people WHERE role = 'kid'").all();
  const due = [];
  for (const kid of kids) {
    const streak = currentStreak(db, kid.id);
    if (streakAtRisk(db, kid.id, warningTime, streak)) {
      due.push({ personId: kid.id, streakDays: streak });
    }
  }
  return due;
}

export function startScheduler(db) {
  const sent = new Set();
  let lastDate = today();

  setInterval(() => {
    try {
      const t = today();
      if (t !== lastDate) { sent.clear(); lastDate = t; }

      for (const { personId, streakDays } of streakReminderDue(db)) {
        const key = `${personId}:${t}`;
        if (sent.has(key)) continue;
        sent.add(key);
        sendToPerson(db, personId, {
          title: 'Streak at risk!',
          body: `Your ${streakDays} day streak ends tonight. Finish your chores!`,
          tag: 'streak',
        });
      }
    } catch (e) {
      console.error('scheduler tick failed:', e);
    }
  }, 60_000);
}
