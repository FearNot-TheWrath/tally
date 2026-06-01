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

test('PATCH wall_radar_station accepts a 3-4 letter id and rejects junk', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  assert.equal((await agent.patch('/api/admin/settings/wall_radar_station').send({ value: 'KGRK' })).status, 200);
  assert.equal((await agent.patch('/api/admin/settings/wall_radar_station').send({ value: '12' })).status, 400);
});
