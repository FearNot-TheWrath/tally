import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';

async function asParent(app, db) {
  const id = db.prepare("INSERT INTO people (name, role) VALUES ('Mom','parent') RETURNING id").get().id;
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id, pin: '1234' });
  return agent;
}

test('PATCH wall_enabled_panels accepts a valid list', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const r = await agent.patch('/api/admin/settings/wall_enabled_panels').send({ value: 'chores,weather' });
  assert.equal(r.status, 200);
});

test('PATCH wall_enabled_panels rejects a list missing chores', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const r = await agent.patch('/api/admin/settings/wall_enabled_panels').send({ value: 'weather,calendar' });
  assert.equal(r.status, 400);
});

test('PATCH wall_enabled_panels rejects an unknown panel key', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const r = await agent.patch('/api/admin/settings/wall_enabled_panels').send({ value: 'chores,sports' });
  assert.equal(r.status, 400);
});

test('PATCH wall_chores_dwell_sec accepts 60', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const r = await agent.patch('/api/admin/settings/wall_chores_dwell_sec').send({ value: '60' });
  assert.equal(r.status, 200);
});

test('PATCH wall_chores_dwell_sec rejects 4 and 601', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const a = await agent.patch('/api/admin/settings/wall_chores_dwell_sec').send({ value: '4' });
  assert.equal(a.status, 400);
  const b = await agent.patch('/api/admin/settings/wall_chores_dwell_sec').send({ value: '601' });
  assert.equal(b.status, 400);
});

test('PATCH wall_weather_lat accepts empty, 0, 90, -90 and rejects 91', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  for (const v of ['', '0', '90', '-90']) {
    const r = await agent.patch('/api/admin/settings/wall_weather_lat').send({ value: v });
    assert.equal(r.status, 200, `expected 200 for ${JSON.stringify(v)} got ${r.status}`);
  }
  const bad = await agent.patch('/api/admin/settings/wall_weather_lat').send({ value: '91' });
  assert.equal(bad.status, 400);
});

test('PATCH wall_weather_unit accepts F and C only', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  assert.equal((await agent.patch('/api/admin/settings/wall_weather_unit').send({ value: 'F' })).status, 200);
  assert.equal((await agent.patch('/api/admin/settings/wall_weather_unit').send({ value: 'C' })).status, 200);
  assert.equal((await agent.patch('/api/admin/settings/wall_weather_unit').send({ value: 'K' })).status, 400);
});

test('PATCH wall_sleep_start accepts 22:00 and rejects 25:00', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  assert.equal((await agent.patch('/api/admin/settings/wall_sleep_start').send({ value: '22:00' })).status, 200);
  assert.equal((await agent.patch('/api/admin/settings/wall_sleep_start').send({ value: '25:00' })).status, 400);
});

test('PATCH wall_sleep_clock_style accepts the three known values', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  for (const v of ['digital', 'analog-minimal', 'analog-classic']) {
    assert.equal((await agent.patch('/api/admin/settings/wall_sleep_clock_style').send({ value: v })).status, 200);
  }
  assert.equal((await agent.patch('/api/admin/settings/wall_sleep_clock_style').send({ value: 'apple' })).status, 400);
});

test('PATCH wall_weather_radar accepts on/off and rejects junk', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  assert.equal((await agent.patch('/api/admin/settings/wall_weather_radar').send({ value: 'off' })).status, 200);
  assert.equal((await agent.patch('/api/admin/settings/wall_weather_radar').send({ value: 'on' })).status, 200);
  assert.equal((await agent.patch('/api/admin/settings/wall_weather_radar').send({ value: 'maybe' })).status, 400);
});

test('PATCH wall_verse_dwell_sec accepts an int in range', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const r = await agent.patch('/api/admin/settings/wall_verse_dwell_sec').send({ value: '25' });
  assert.equal(r.status, 200);
  assert.equal(r.body.setting.value, '25');
});
test('PATCH wall_verse_dwell_sec rejects out-of-range', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const r = await agent.patch('/api/admin/settings/wall_verse_dwell_sec').send({ value: '999' });
  assert.equal(r.status, 400);
});
test('PATCH wall_enabled_panels accepts verse', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const r = await agent.patch('/api/admin/settings/wall_enabled_panels').send({ value: 'chores,weather,verse' });
  assert.equal(r.status, 200);
});

test('PATCH wall_smart_cycle accepts on and off, rejects others', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  assert.equal((await agent.patch('/api/admin/settings/wall_smart_cycle').send({ value: 'on' })).status, 200);
  assert.equal((await agent.patch('/api/admin/settings/wall_smart_cycle').send({ value: 'off' })).status, 200);
  assert.equal((await agent.patch('/api/admin/settings/wall_smart_cycle').send({ value: 'maybe' })).status, 400);
});

test('PATCH per-panel dwell sec accepts 5..600 only', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  for (const key of ['wall_weather_dwell_sec', 'wall_calendar_dwell_sec', 'wall_verse_dwell_sec']) {
    assert.equal((await agent.patch(`/api/admin/settings/${key}`).send({ value: '30' })).status, 200, key);
    assert.equal((await agent.patch(`/api/admin/settings/${key}`).send({ value: '4' })).status, 400, key);
    assert.equal((await agent.patch(`/api/admin/settings/${key}`).send({ value: '601' })).status, 400, key);
  }
});

test('PATCH wall_weather_location accepts empty and short strings, rejects very long', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  assert.equal((await agent.patch('/api/admin/settings/wall_weather_location').send({ value: '' })).status, 200);
  assert.equal((await agent.patch('/api/admin/settings/wall_weather_location').send({ value: '78634' })).status, 200);
  assert.equal((await agent.patch('/api/admin/settings/wall_weather_location').send({ value: 'x'.repeat(101) })).status, 400);
});

test('PATCH wall_weather_location with a zip code geocodes and writes lat/lon', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /postal_code=78634/);
    return { ok: true, status: 200, json: async () => ({
      results: [{ latitude: 30.5083, longitude: -97.5469, name: 'Hutto' }],
    }) };
  };
  try {
    const r = await agent.patch('/api/admin/settings/wall_weather_location').send({ value: '78634' });
    assert.equal(r.status, 200);
    assert.equal(r.body.resolved.lat, 30.5083);
    assert.equal(r.body.resolved.lon, -97.5469);
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='wall_weather_lat'").get().value, '30.5083');
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='wall_weather_lon'").get().value, '-97.5469');
  } finally {
    globalThis.fetch = original;
  }
});

test('PATCH wall_weather_location with empty string clears lat/lon', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  db.prepare("UPDATE settings SET value='30.5' WHERE key='wall_weather_lat'").run();
  db.prepare("UPDATE settings SET value='-97.5' WHERE key='wall_weather_lon'").run();
  const r = await agent.patch('/api/admin/settings/wall_weather_location').send({ value: '' });
  assert.equal(r.status, 200);
  assert.equal(r.body.resolved, null);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='wall_weather_lat'").get().value, '');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='wall_weather_lon'").get().value, '');
});

test('PATCH wall_calendar_selected_ids accepts short strings, rejects very long', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  assert.equal((await agent.patch('/api/admin/settings/wall_calendar_selected_ids').send({ value: '' })).status, 200);
  assert.equal((await agent.patch('/api/admin/settings/wall_calendar_selected_ids').send({ value: 'a,b,c' })).status, 200);
  assert.equal((await agent.patch('/api/admin/settings/wall_calendar_selected_ids').send({ value: 'x'.repeat(4097) })).status, 400);
});

test('GET /api/admin/settings does NOT expose wall_calendar_oauth_refresh or list_cache', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  db.prepare("UPDATE settings SET value='SECRETSECRET' WHERE key='wall_calendar_oauth_refresh'").run();
  const r = await agent.get('/api/admin/settings');
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.wall_calendar_oauth_refresh, undefined);
  assert.equal(r.body.settings.wall_calendar_list_cache, undefined);
});
