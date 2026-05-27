import { Router } from 'express';
import { today, weekStart } from '../lib/dates.js';
import { calcWeekPoints } from '../lib/points.js';
import { currentStreak, isOnFreeze } from '../lib/streak.js';
import { wallBus } from '../lib/events.js';
import { runPayoutIfDue } from '../lib/payout.js';

export function wallRoutes() {
  const r = Router();

  r.get('/wall/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':ok\n\n');

    const onRefresh = () => res.write('event: refresh\ndata: {}\n\n');
    wallBus.on('refresh', onRefresh);
    res.on('close', () => wallBus.off('refresh', onRefresh));
  });

  r.get('/wall', (req, res) => {
    const db = req.app.get('db');
    runPayoutIfDue(db);
    const kids = db.prepare(`
      SELECT id, name, avatar_color, weekly_target_pts, streak_days, bank_cents
      FROM people WHERE role = 'kid' ORDER BY id
    `).all();

    const todayIso = today();
    const ws = weekStart(todayIso);

    const kidIds = kids.map(k => k.id);
    const assignmentRows = kidIds.length === 0 ? [] : db.prepare(`
      SELECT a.id, a.person_id, a.due_date, a.status, a.stolen_from,
             c.title, c.weight, c.kind, c.points AS chore_points,
             sf.name AS stolen_from_name
      FROM assignments a
      JOIN chores c ON c.id = a.chore_id
      LEFT JOIN people sf ON sf.id = a.stolen_from
      WHERE a.person_id IN (${kidIds.map(() => '?').join(',')})
        AND (a.due_date = ? OR (a.due_date < ? AND a.status NOT IN ('done','expired','rejected')))
      ORDER BY a.due_date, c.title
    `).all(...kidIds, todayIso, todayIso);

    // Pre-compute totalWeight per kid (used both for the kid summary and per-row display_points)
    const totals = new Map();
    let total = 0, done = 0;
    for (const kid of kids) {
      kid.today = [];
      kid.overdue = [];
      const pts = calcWeekPoints(db, kid.id, ws);
      kid.points = pts.points;
      kid.percent = pts.percent;
      totals.set(kid.id, pts.totalWeight);
      kid.streak_days = currentStreak(db, kid.id);
      kid.on_freeze = isOnFreeze(db, kid.id);
    }
    for (const a of assignmentRows) {
      const kid = kids.find(k => k.id === a.person_id);
      if (!kid) continue;
      const target = kid.weekly_target_pts || 0;
      const totalWeight = totals.get(kid.id) || 0;
      if (a.kind === 'bonus') {
        a.display_points = a.chore_points;
        a.is_bonus = 1;
      } else {
        a.display_points = totalWeight > 0 ? Math.round(a.weight / totalWeight * target) : 0;
        a.is_bonus = 0;
      }
      const bucket = a.due_date === todayIso ? kid.today : kid.overdue;
      bucket.push(a);
      total++;
      if (a.status === 'done') done++;
    }
    const housePct = total === 0 ? 100 : Math.round((done / total) * 100);

    const bonuses = db.prepare(`
      SELECT c.id, c.title, c.points, c.anti_cheat
      FROM chores c
      LEFT JOIN assignments a ON a.chore_id = c.id
      WHERE c.kind = 'bonus' AND c.deleted_at IS NULL AND a.id IS NULL
      ORDER BY c.created_at DESC
    `).all();

    let streak_leader = null;
    for (const kid of kids) {
      if (kid.streak_days > 0) {
        if (!streak_leader
            || kid.streak_days > streak_leader.streak_days
            || (kid.streak_days === streak_leader.streak_days && kid.name < streak_leader.name)) {
          streak_leader = { name: kid.name, color: kid.avatar_color, streak_days: kid.streak_days };
        }
      }
    }

    res.json({ kids, house_pct: housePct, today: todayIso, bonuses, streak_leader });
  });

  return r;
}
