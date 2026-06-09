import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';
import { encryptForSetting } from '../src/lib/crypto-settings.js';

async function asParent(app, db) {
  const id = db.prepare("INSERT INTO people (name, role) VALUES ('Mom','parent') RETURNING id").get().id;
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ person_id: id, pin: '1234' });
  return agent;
}

test('GET /api/admin/calendar/list returns cached list', async () => {
  const db = freshDb();
  db.prepare("UPDATE settings SET value=? WHERE key='wall_calendar_list_cache'").run(JSON.stringify([
    { id: 'a', summary: 'Family', backgroundColor: '#FF0000', primary: true, accessRole: 'owner' },
  ]));
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const r = await agent.get('/api/admin/calendar/list');
  assert.equal(r.status, 200);
  assert.equal(r.body.connected, false);
  assert.equal(r.body.calendars.length, 1);
});

test('GET /api/admin/calendar/list reports connected when refresh present', async () => {
  const db = freshDb();
  const secret = process.env.SESSION_SECRET || 'dev-secret-change-me';
  db.prepare("UPDATE settings SET value=? WHERE key='wall_calendar_oauth_refresh'").run(encryptForSetting('RT', secret));
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const r = await agent.get('/api/admin/calendar/list');
  assert.equal(r.body.connected, true);
});

test('POST /api/admin/calendar/disconnect clears refresh + selected + list cache', async () => {
  const db = freshDb();
  const secret = process.env.SESSION_SECRET || 'dev-secret-change-me';
  db.prepare("UPDATE settings SET value=? WHERE key='wall_calendar_oauth_refresh'").run(encryptForSetting('RT', secret));
  db.prepare("UPDATE settings SET value='a,b' WHERE key='wall_calendar_selected_ids'").run();
  db.prepare("UPDATE settings SET value='[1]' WHERE key='wall_calendar_list_cache'").run();
  const app = freshApp(db);
  const agent = await asParent(app, db);
  const r = await agent.post('/api/admin/calendar/disconnect');
  assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='wall_calendar_oauth_refresh'").get().value, '');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='wall_calendar_selected_ids'").get().value, '');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='wall_calendar_list_cache'").get().value, '[]');
});
