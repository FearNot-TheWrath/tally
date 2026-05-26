import { openDb } from './src/db.js';
import { buildApp } from './src/app.js';

const PORT = process.env.PORT || 3007;
const SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';

const db = openDb('./tally.db');
const app = buildApp({ db, sessionSecret: SECRET });

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Tally listening on http://localhost:${PORT}`);
});
