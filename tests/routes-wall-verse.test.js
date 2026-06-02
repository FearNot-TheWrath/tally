import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp, freshDb } from './helpers.js';

test('GET /api/wall/verse returns a verse object', async () => {
  const db = freshDb(); const app = freshApp(db);
  const res = await request(app).get('/api/wall/verse');
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.verseText === 'string');
  assert.ok(['daily', 'curated'].includes(res.body.source));
});

test('GET /api/wall/config includes verse_dwell_sec', async () => {
  const db = freshDb(); const app = freshApp(db);
  const res = await request(app).get('/api/wall/config');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.verse_dwell_sec, 'number');
});
