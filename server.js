import { openDb } from './src/db.js';
import { buildApp } from './src/app.js';
import { generateForToday } from './src/lib/assignments.js';

const PORT = process.env.PORT || 3007;
const SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';

const db = openDb('./tally.db');
const app = buildApp({ db, sessionSecret: SECRET });

generateForToday(db);
setInterval(() => {
  try { generateForToday(db); }
  catch (e) { console.error('generator failed:', e); }
}, 60 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Tally listening on http://localhost:${PORT}`);
});
