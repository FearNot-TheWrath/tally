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

test('GET /api/auth/google/start redirects to Google with state + scope', async () => {
  process.env.GOOGLE_CLIENT_ID = 'cid';
  process.env.GOOGLE_REDIRECT_URI = 'https://example.com/cb';
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const r = await agent.get('/api/auth/google/start');
  assert.equal(r.status, 302);
  assert.match(r.headers.location, /accounts\.google\.com/);
  assert.match(r.headers.location, /scope=https/);
  assert.match(r.headers.location, /state=[a-f0-9]+/);
  assert.match(r.headers.location, /access_type=offline/);
  assert.match(r.headers.location, /prompt=consent/);
});

test('GET /api/auth/google/callback rejects mismatched state', async () => {
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  // hit start first to set the cookie state
  await agent.get('/api/auth/google/start');
  const r = await agent.get('/api/auth/google/callback?code=c&state=WRONG');
  assert.equal(r.status, 302);
  assert.match(r.headers.location, /wall_calendar_error=state/);
});

test('GET /api/auth/google/callback exchanges code and stores encrypted refresh', async () => {
  process.env.GOOGLE_CLIENT_ID = 'cid';
  process.env.GOOGLE_CLIENT_SECRET = 'secret';
  process.env.GOOGLE_REDIRECT_URI = 'https://example.com/cb';
  const db = freshDb(); const app = freshApp(db);
  const agent = await asParent(app, db);
  const startRes = await agent.get('/api/auth/google/start');
  const state = startRes.headers.location.match(/state=([a-f0-9]+)/)[1];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (/token/.test(String(url))) return { ok: true, status: 200, json: async () => ({
      access_token: 'AT', refresh_token: 'RT', expires_in: 3600,
    }) };
    if (/calendarList/.test(String(url))) return { ok: true, status: 200, json: async () => ({ items: [
      { id: 'a', summary: 'Family', backgroundColor: '#FF0000', primary: true, accessRole: 'owner' },
    ] }) };
    throw new Error('unexpected fetch ' + url);
  };
  try {
    const r = await agent.get(`/api/auth/google/callback?code=goodcode&state=${state}`);
    assert.equal(r.status, 302);
    assert.match(r.headers.location, /admin.*#wall/);
    const stored = db.prepare("SELECT value FROM settings WHERE key='wall_calendar_oauth_refresh'").get().value;
    assert.ok(stored && stored.length > 0);
    assert.notEqual(stored, 'RT'); // encrypted
    const list = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='wall_calendar_list_cache'").get().value);
    assert.equal(list[0].id, 'a');
  } finally { globalThis.fetch = origFetch; }
});
