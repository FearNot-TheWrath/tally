import express from 'express';
import cookieSession from 'cookie-session';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { authRoutes, meRoute } from './routes/auth.js';
import { homeRoutes } from './routes/home.js';
import { wallRoutes } from './routes/wall.js';
import { adminPeopleRoutes } from './routes/admin/people.js';
import { adminChoresRoutes } from './routes/admin/chores.js';
import { adminTodayRoutes } from './routes/admin/today.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildApp({ db, sessionSecret = 'dev-secret' }) {
  const app = express();
  app.set('db', db);
  app.use(express.json({ limit: '8mb' }));
  app.use(cookieSession({
    name: 'tally_session',
    keys: [sessionSecret],
    maxAge: 365 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    httpOnly: true,
  }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes());
  app.use('/api', meRoute());
  app.use('/api', homeRoutes());
  app.use('/api', wallRoutes());
  app.use('/api/admin', adminPeopleRoutes());
  app.use('/api/admin', adminChoresRoutes());
  app.use('/api/admin', adminTodayRoutes());

  app.use(express.static(join(__dirname, '..', 'public')));

  return app;
}
