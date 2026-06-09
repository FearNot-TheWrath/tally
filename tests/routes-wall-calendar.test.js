import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';
import { _resetCalendarCache } from '../src/routes/wall.js';
import { encryptForSetting } from '../src/lib/crypto-settings.js';

function setRefresh(db, plain) {
  const secret = process.env.SESSION_SECRET || 'dev-secret-change-me';
  const ct = encryptForSetting(plain, secret);
  db.prepare("UPDATE settings SET value=? WHERE key='wall_calendar_oauth_refresh'").run(ct);
}
function setSelected(db, csv) {
  db.prepare("UPDATE settings SET value=? WHERE key='wall_calendar_selected_ids'").run(csv);
}

test('GET /api/wall/calendar returns skip when not connected', async () => {
  _resetCalendarCache();
  const db = freshDb();
  const app = freshApp(db);
  const r = await request(app).get('/api/wall/calendar');
  assert.equal(r.status, 200);
  assert.equal(r.body.skip, true);
  assert.match(r.body.reason || '', /not connected/);
});

test('GET /api/wall/calendar returns skip when connected but no calendars selected', async () => {
  _resetCalendarCache();
  const db = freshDb();
  setRefresh(db, 'RT');
  const app = freshApp(db);
  const r = await request(app).get('/api/wall/calendar');
  assert.equal(r.body.skip, true);
  assert.match(r.body.reason || '', /no calendars/);
});

test('GET /api/wall/calendar returns grouped events', async () => {
  _resetCalendarCache();
  const db = freshDb();
  setRefresh(db, 'RT');
  setSelected(db, 'cal-1');
  db.prepare("UPDATE settings SET value=? WHERE key='wall_calendar_list_cache'").run(JSON.stringify([
    { id: 'cal-1', summary: 'Family', backgroundColor: '#22C55E', primary: true, accessRole: 'owner' },
  ]));
  const today = new Date().toISOString().slice(0,10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0,10);
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (/token/.test(String(url))) return { ok: true, status: 200, json: async () => ({ access_token: 'AT', expires_in: 3600 }) };
    if (/calendars\/cal-1\/events/.test(String(url))) return { ok: true, status: 200, json: async () => ({ items: [
      { id: 'e1', status: 'confirmed', summary: 'Robotics', location: 'Hutto HS', start: { dateTime: `${today}T19:00:00-05:00` }, end: { dateTime: `${today}T20:00:00-05:00` } },
      { id: 'e2', status: 'confirmed', summary: 'School day', start: { date: today }, end: { date: tomorrow } },
      { id: 'e3', status: 'confirmed', summary: 'Soccer', start: { dateTime: `${tomorrow}T17:00:00-05:00` }, end: { dateTime: `${tomorrow}T18:00:00-05:00` } },
    ] }) };
    throw new Error('unexpected ' + url);
  };
  try {
    const app = freshApp(db);
    const r = await request(app).get('/api/wall/calendar');
    assert.equal(r.status, 200);
    assert.equal(r.body.skip, undefined);
    assert.ok(Array.isArray(r.body.today.timed));
    assert.ok(Array.isArray(r.body.today.allDay));
    assert.equal(r.body.today.timed.length, 1);
    assert.equal(r.body.today.allDay.length, 1);
    assert.equal(r.body.tomorrow.timed.length, 1);
    assert.equal(r.body.today.timed[0].calendar_color, '#22C55E');
  } finally { globalThis.fetch = original; }
});

test('GET /api/wall/calendar returns skip + clears refresh on invalid_grant', async () => {
  _resetCalendarCache();
  const db = freshDb();
  setRefresh(db, 'EXPIRED');
  setSelected(db, 'cal-1');
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => '{"error":"invalid_grant"}' });
  try {
    const app = freshApp(db);
    const r = await request(app).get('/api/wall/calendar');
    assert.equal(r.body.skip, true);
    assert.match(r.body.reason || '', /reconnect/);
    const cleared = db.prepare("SELECT value FROM settings WHERE key='wall_calendar_oauth_refresh'").get().value;
    assert.equal(cleared, '');
  } finally { globalThis.fetch = original; }
});
