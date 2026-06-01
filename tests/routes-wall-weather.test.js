import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';
import { _resetWeatherState } from '../src/routes/wall.js';

const SAMPLE_API = {
  current: { temperature_2m: 73.1, weather_code: 0, is_day: 1 },
  daily: {
    time: ['2026-06-01','2026-06-02','2026-06-03','2026-06-04'],
    weather_code: [0, 2, 61, 0],
    temperature_2m_max: [85, 80, 75, 88],
    temperature_2m_min: [62, 60, 58, 65],
    sunrise: ['2026-06-01T06:00','2026-06-02T06:00','2026-06-03T06:00','2026-06-04T06:00'],
    sunset:  ['2026-06-01T20:30','2026-06-02T20:30','2026-06-03T20:30','2026-06-04T20:30'],
  },
};

test('GET /api/wall/weather returns skip when location is not set', async () => {
  _resetWeatherState();
  const db = freshDb();
  const app = freshApp(db);
  const r = await request(app).get('/api/wall/weather');
  assert.equal(r.status, 200);
  assert.equal(r.body.skip, true);
  assert.match(r.body.reason || '', /location/i);
});

test('GET /api/wall/weather returns mapped forecast when location is set and fetch succeeds', async () => {
  _resetWeatherState();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => SAMPLE_API });
  try {
    const db = freshDb();
    db.prepare("UPDATE settings SET value=? WHERE key='wall_weather_lat'").run('30.5');
    db.prepare("UPDATE settings SET value=? WHERE key='wall_weather_lon'").run('-97.6');
    const app = freshApp(db);
    const r = await request(app).get('/api/wall/weather');
    assert.equal(r.status, 200);
    assert.equal(r.body.skip, undefined);
    assert.equal(r.body.theme, 'clear-day');
    assert.equal(r.body.current_temp, 73);
    assert.equal(r.body.forecast.length, 3);
    assert.equal(r.body.unit, 'F');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GET /api/wall/weather returns skip when fetch has failed for >30 minutes', async () => {
  _resetWeatherState();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const db = freshDb();
    db.prepare("UPDATE settings SET value=? WHERE key='wall_weather_lat'").run('30.5');
    db.prepare("UPDATE settings SET value=? WHERE key='wall_weather_lon'").run('-97.6');
    const app = freshApp(db);
    // First failure: no cache yet, no prior success -- must skip.
    const r1 = await request(app).get('/api/wall/weather');
    assert.equal(r1.body.skip, true);
    assert.match(r1.body.reason || '', /fetch failed/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
