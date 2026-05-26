import { readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Delete any *.jpg under uploadsDir whose mtime is older than maxAgeDays.
 * Also nulls assignments.photo_path for any row pointing at a deleted file.
 *
 * @param {Database} db better-sqlite3 instance
 * @param {string} uploadsDir absolute or relative path to uploads root
 * @param {number} maxAgeDays files older than this get deleted
 * @returns {{ deleted: number, kept: number }}
 */
export function purgeOldPhotos(db, uploadsDir, maxAgeDays = 5) {
  let deleted = 0;
  let kept = 0;
  if (!existsSync(uploadsDir)) return { deleted, kept };

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const nullStmt = db.prepare(
    "UPDATE assignments SET photo_path = NULL, updated_at = datetime('now') WHERE photo_path = ?"
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
          nullStmt.run(file);
          deleted++;
        } catch { /* file vanished between stat and unlink, ignore */ }
      } else {
        kept++;
      }
    }
  }
  return { deleted, kept };
}
