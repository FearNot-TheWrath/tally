import { today, toIso, fromIso, weekStart } from './dates.js';
import { calcWeekPoints, calcProjectedPay } from './points.js';

const DAY_MAP = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

let lastPayoutCheck = 0;

export function _resetCache() {
  lastPayoutCheck = 0;
}

export function runPayoutIfDue(db) {
  const now = Date.now();
  if (now - lastPayoutCheck < 60_000) return;
  lastPayoutCheck = now;

  const dayRow = db.prepare("SELECT value FROM settings WHERE key = 'payout_day'").get();
  const timeRow = db.prepare("SELECT value FROM settings WHERE key = 'payout_time'").get();
  const payoutDay = DAY_MAP[dayRow?.value || 'sunday'];
  const payoutTime = timeRow?.value || '20:00';

  const boundary = mostRecentBoundary(payoutDay, payoutTime);
  if (!boundary) return;

  const boundaryWs = weekStartFromBoundary(boundary);

  const kids = db.prepare("SELECT * FROM people WHERE role = 'kid'").all();
  if (kids.length === 0) return;

  for (let weeksBack = 8; weeksBack >= 0; weeksBack--) {
    const d = fromIso(boundaryWs);
    d.setDate(d.getDate() - weeksBack * 7);
    const ws = toIso(d);

    const alreadyPaid = db.prepare(
      "SELECT 1 FROM transactions WHERE type = 'deposit' AND week_start = ? LIMIT 1"
    ).get(ws);
    if (alreadyPaid) continue;

    const deposit = db.transaction(() => {
      for (const kid of kids) {
        const existing = db.prepare(
          "SELECT 1 FROM transactions WHERE person_id = ? AND type = 'deposit' AND week_start = ?"
        ).get(kid.id, ws);
        if (existing) continue;

        const pts = calcWeekPoints(db, kid.id, ws);
        const earned = calcProjectedPay(kid, pts.points);

        db.prepare(
          "INSERT INTO transactions (person_id, type, amount_cents, note, week_start) VALUES (?, 'deposit', ?, ?, ?)"
        ).run(kid.id, earned, `Week of ${ws}`, ws);

        if (earned > 0) {
          db.prepare("UPDATE people SET bank_cents = bank_cents + ? WHERE id = ?").run(earned, kid.id);
        }
      }
    });
    deposit();
  }
}

function mostRecentBoundary(payoutDayNum, payoutTime) {
  const now = new Date();
  const [hh, mm] = payoutTime.split(':').map(Number);
  const d = new Date(now);

  for (let i = 0; i < 8; i++) {
    if (d.getDay() === payoutDayNum) {
      const cutoff = new Date(d);
      cutoff.setHours(hh, mm, 0, 0);
      if (i === 0 && now < cutoff) {
        d.setDate(d.getDate() - 1);
        continue;
      }
      return toIso(d);
    }
    d.setDate(d.getDate() - 1);
  }
  return null;
}

function weekStartFromBoundary(boundaryIso) {
  const d = fromIso(boundaryIso);
  const dow = d.getDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + offset);
  return toIso(d);
}
