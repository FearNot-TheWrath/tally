import { mkdirSync } from 'node:fs';
import { openDb } from './src/db.js';
import { buildApp } from './src/app.js';
import { generateForToday } from './src/lib/assignments.js';
import { purgeOldPhotos } from './src/lib/retention.js';

const PORT = process.env.PORT || 3007;
const SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const UPLOADS_DIR = './uploads';
const PHOTO_RETENTION_DAYS = 5;

const db = openDb('./tally.db');
mkdirSync(UPLOADS_DIR, { recursive: true });

const app = buildApp({ db, sessionSecret: SECRET, uploadsDir: UPLOADS_DIR });

generateForToday(db);
setInterval(() => {
  try { generateForToday(db); }
  catch (e) { console.error('generator failed:', e); }
}, 60 * 60 * 1000);

// Daily retention sweep: delete photos older than PHOTO_RETENTION_DAYS days.
try {
  const r = purgeOldPhotos(db, UPLOADS_DIR, PHOTO_RETENTION_DAYS);
  if (r.deleted) console.log(`retention sweep: deleted ${r.deleted}, kept ${r.kept}`);
} catch (e) { console.error('retention sweep on boot failed:', e); }
setInterval(() => {
  try {
    const r = purgeOldPhotos(db, UPLOADS_DIR, PHOTO_RETENTION_DAYS);
    if (r.deleted) console.log(`retention sweep: deleted ${r.deleted}, kept ${r.kept}`);
  } catch (e) { console.error('retention sweep failed:', e); }
}, 24 * 60 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Tally listening on http://localhost:${PORT}`);
});
