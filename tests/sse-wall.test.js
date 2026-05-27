import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { freshApp, freshDb } from './helpers.js';
import { wallBus, notifyWall } from '../src/lib/events.js';

function sseRequest(port, opts = {}) {
  const timeout = opts.timeout || 2000;
  return new Promise((resolve) => {
    let data = '';
    const req = http.get(`http://localhost:${port}/api/wall/events`, (res) => {
      res.on('data', (chunk) => {
        data += chunk.toString();
        if (opts.until && opts.until(data)) {
          req.destroy();
          resolve({ data, headers: res.headers });
        }
      });
    });
    req.on('error', () => {});
    setTimeout(() => { req.destroy(); resolve({ data, headers: null }); }, timeout);
  });
}

test('GET /api/wall/events returns SSE headers and initial :ok comment', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const server = app.listen(0);
  const port = server.address().port;

  const { data, headers } = await sseRequest(port, {
    until: (d) => d.includes(':ok'),
    timeout: 1000,
  });

  server.close();
  assert.equal(headers['content-type'], 'text/event-stream');
  assert.equal(headers['cache-control'], 'no-cache');
  assert.ok(data.includes(':ok'));
});

test('notifyWall sends refresh event through SSE stream', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const server = app.listen(0);
  const port = server.address().port;

  const result = sseRequest(port, {
    until: (d) => d.includes('event: refresh'),
    timeout: 1000,
  });

  await new Promise(r => setTimeout(r, 50));
  notifyWall();

  const { data } = await result;
  server.closeAllConnections();
  server.close();
  await new Promise(r => setTimeout(r, 100));
  assert.ok(data.includes('event: refresh'));
  assert.ok(data.includes('data: {}'));
});

test('SSE cleans up wallBus listener when connection closes', async () => {
  const db = freshDb();
  const app = freshApp(db);
  const server = app.listen(0);
  const port = server.address().port;

  await new Promise((resolve) => {
    http.get(`http://localhost:${port}/api/wall/events`, (res) => {
      res.once('data', resolve);
    }).on('error', () => {});
  });

  const during = wallBus.listenerCount('refresh');
  assert.ok(during >= 1);

  server.closeAllConnections();
  server.close();
  await new Promise(r => setTimeout(r, 200));

  assert.ok(wallBus.listenerCount('refresh') < during);
});
