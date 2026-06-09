let lastCheck = 0;

export function _resetCache() { lastCheck = 0; }

export function ripeningStep(min, max, days) {
  if (max <= min) return 0;
  return Math.round((max - min) / days);
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function daysBetween(fromIso, toIso) {
  const a = new Date(fromIso + 'T00:00:00');
  const b = new Date(toIso   + 'T00:00:00');
  return Math.round((b - a) / 86_400_000);
}

export function sweepBonusRipening(db) {
  const now = Date.now();
  if (now - lastCheck < 60_000) return;
  lastCheck = now;

  const today = todayIso();
  const rows = db.prepare(`
    SELECT id, min_points, max_points, days_to_ripen, current_points, ripens_from, ripens_full_on
    FROM chores
    WHERE kind = 'bonus'
      AND deleted_at IS NULL
      AND min_points IS NOT NULL
      AND max_points IS NOT NULL
      AND ripens_from IS NOT NULL
  `).all();

  for (const r of rows) {
    // 1. Soft-delete bonuses that have been at max since at least yesterday.
    if (r.ripens_full_on && r.ripens_full_on < today) {
      db.prepare(`UPDATE chores SET deleted_at = datetime('now') WHERE id = ?`).run(r.id);
      continue;
    }
    // 2. Skip min==max bonuses (no ripening configured).
    const step = ripeningStep(r.min_points, r.max_points, r.days_to_ripen);
    if (step <= 0) continue;
    // 3. Skip bonuses already touched today.
    if (r.ripens_from >= today) continue;

    const elapsed = Math.max(1, daysBetween(r.ripens_from, today));
    let next = (r.current_points ?? r.min_points) + step * elapsed;
    let reachedFull = false;
    if (next >= r.max_points) {
      next = r.max_points;
      reachedFull = true;
    }
    db.prepare(`
      UPDATE chores SET current_points = ?, ripens_from = ?,
        ripens_full_on = COALESCE(ripens_full_on, CASE WHEN ? = 1 THEN ? ELSE NULL END)
      WHERE id = ?
    `).run(next, today, reachedFull ? 1 : 0, today, r.id);
  }
}
