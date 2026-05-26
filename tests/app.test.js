import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { freshApp } from './helpers.js';

test('GET /api/health returns ok', async () => {
  const app = freshApp();
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});
