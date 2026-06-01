import { readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Delete any *.jpg under uploadsDir whose mtime is older than the retention threshold.
 * Also deletes assignment_photos rows pointing at a deleted file.
 *
 * @param {Database} db better-sqlite3 instance
 * @param {string} uploadsDir absolute or relative path to uploads root
 * @param {number} defaultDays fallback when the photo_retention_days setting is unset/invalid
 * @returns {{ deleted: number, kept: number }}
 */
export function purgeOldPhotos(db, uploadsDir, defaultDays = 5) {
  let deleted = 0;
  let kept = 0;
  if (!existsSync(uploadsDir)) return { deleted, kept };

  let days = defaultDays;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'photo_retention_days'").get();
  if (row && row.value) {
    const parsed = parseInt(row.value, 10);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 30) days = parsed;
  }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const delStmt = db.prepare(
    'DELETE FROM assignment_photos WHERE path = ?'
  );

  for (const ym of readdirSync(uploadsDir)) {
    const ymDir = join(uploadsDir, ym);
    let entries;
    try { entries = readdirSync(ymDir); }
    catch { continue; }
    for (const name of entries) {
      if (!name.endsWith('.jpg')) continue;
      const file = join(ymDir, name);
      let mtimeMs;
      try { mtimeMs = statSync(file).mtimeMs; }
      catch { continue; }
      if (mtimeMs < cutoff) {
        try {
          unlinkSync(file);
          delStmt.run(file);
          deleted++;
        } catch { /* file vanished between stat and unlink, ignore */ }
      } else {
        kept++;
      }
    }
  }
  return { deleted, kept };
}
