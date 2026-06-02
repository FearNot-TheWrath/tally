import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';

test('GET /api/wall/config returns the wall-public settings (no auth required)', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const res = await request(app).get('/api/wall/config');
  assert.equal(res.status, 200);
  const c = res.body;
  assert.equal(c.enabled_panels, 'chores,weather,verse');
  assert.equal(c.chores_dwell_sec, 60);
  assert.equal(c.other_dwell_sec, 15);
  assert.equal(c.weather_unit, 'F');
  assert.equal(c.sleep_start, '22:00');
  assert.equal(c.sleep_end, '06:00');
  assert.equal(c.sleep_clock_style, 'analog-minimal');
  // Must NOT include encrypted refresh token or any non-wall_* key.
  assert.equal(c.admin_pin_hash, undefined);
  assert.equal(c.wall_calendar_oauth_refresh, undefined);
});

test('GET /api/wall/config reflects updated settings', async () => {
  const db = freshDb();
  const app = freshApp(db);
  db.prepare("UPDATE settings SET value = ? WHERE key = ?").run('40', 'wall_chores_dwell_sec');
  const res = await request(app).get('/api/wall/config');
  assert.equal(res.body.chores_dwell_sec, 40);
});
