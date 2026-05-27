# Tally — Phase 5 (SSE Realtime Wall) Design

**Date:** 2026-05-27
**Project:** Tally
**Status:** Approved, ready for implementation planning
**Builds on:** Phase 1 (wall display + polling), Phase 6a (streak leader banner on wall)

---

## 1. Summary

Replace the wall display's 10-second polling with Server-Sent Events so chore completions, steals, bonus claims, and parent approvals appear on the wall instantly. An in-process Node EventEmitter acts as the bus. Mutation endpoints fire a `notifyWall()` call after their DB write; a new SSE endpoint pushes a lightweight `refresh` event to all connected wall clients; the wall fetches `/api/wall` fresh on each event, reusing its existing render path. The 10s poll stays as a belt-and-suspenders fallback.

## 2. Goals

1. **Instant wall updates** when any kid or parent action changes what the wall should display.
2. **Zero new dependencies** — Node's built-in EventEmitter, native browser EventSource.
3. **Minimal surface area** — one new ~30-line module, one new SSE route, one-line additions to existing mutation endpoints.
4. **Graceful degradation** — if the SSE connection drops, the existing 10s poll catches up automatically. EventSource auto-reconnects per spec (~3s default).

## 3. Non-goals (Phase 5)

- SSE on kid home or admin screens (home re-renders on button clicks; admin is rarely open long enough)
- Granular patch events (full `/api/wall` fetch on each push; data is small)
- Auth on the SSE endpoint (wall page is already unauthenticated)
- Custom heartbeat/keepalive interval (the 10s poll covers liveness detection)
- Replacing the 10s poll entirely (kept as fallback)

## 4. Architecture

### Event bus: `src/lib/events.js`

New module. Two exports:

```js
wallBus   // EventEmitter instance (singleton)
notifyWall()  // debounced emitter — collapses rapid mutations within 100ms into one 'refresh' event
```

`notifyWall()` is debounced so that a parent approving five chores in quick succession sends one `refresh` event, not five. Implementation: a trailing-edge debounce at 100ms using a simple `clearTimeout`/`setTimeout` pattern. No external debounce library.

### SSE endpoint: `GET /api/wall/events`

Added to `src/routes/wall.js`. Behavior:

1. Set response headers:
   - `Content-Type: text/event-stream`
   - `Cache-Control: no-cache`
   - `Connection: keep-alive`
   - `X-Accel-Buffering: no` (disables proxy buffering in nginx/Cloudflare if present)
2. Write an initial `:ok\n\n` comment so the client knows the stream is alive.
3. Register a listener on `wallBus` for `'refresh'` events. On each event, write `event: refresh\ndata: {}\n\n` to the response.
4. On `req.on('close')`, remove the listener from `wallBus` (prevents memory leaks from disconnected clients).
5. Never call `res.end()` — the connection stays open until the client disconnects.

### Mutation touchpoints

Eight existing endpoints get a one-line `notifyWall()` import and call after their successful DB write:

| # | Endpoint | File |
|---|----------|------|
| 1 | `POST /api/assignments/:id/submit` | `src/routes/home.js` |
| 2 | `POST /api/assignments/:id/undo` | `src/routes/home.js` |
| 3 | `POST /api/assignments/:id/steal` | `src/routes/home.js` |
| 4 | `POST /api/bonuses/:id/claim` | `src/routes/home.js` |
| 5 | `POST /api/admin/approvals/:id/approve` | `src/routes/admin/approvals.js` |
| 6 | `POST /api/admin/approvals/:id/reject` | `src/routes/admin/approvals.js` |
| 7 | `POST /api/admin/bonuses` | `src/routes/admin/bonuses.js` |
| 8 | `DELETE /api/admin/bonuses/:id` | `src/routes/admin/bonuses.js` |

Each call is placed after the `res.json(...)` or `res.status(200).json(...)` line — the HTTP response to the acting client goes out first, then the wall gets notified. This avoids blocking the mutation response on SSE delivery.

### Client: `public/js/pages/wall.js`

After the existing `render(); setInterval(render, 10_000);` block, add:

```js
const sse = new EventSource('/api/wall/events');
sse.addEventListener('refresh', () => render());
```

That's it. `EventSource` handles reconnection automatically. The `render()` function already has a `lastDataJson` guard that skips DOM rebuilds when data hasn't changed, so duplicate triggers (SSE + poll firing close together) are harmless.

No changes to `home.js`, `admin.js`, or any CSS.

## 5. Schema

No schema changes. No new tables or columns.

## 6. API surface

### New endpoint

**`GET /api/wall/events`** — SSE stream. No auth required. Returns `text/event-stream`. Sends `event: refresh` with empty data `{}` whenever a wall-relevant mutation occurs. No request parameters.

### Modified endpoints

The eight mutation endpoints listed in section 4 each get one additional line (`notifyWall()`) but their request/response contracts are unchanged.

## 7. Error handling

- **Client disconnect:** The `'close'` handler on `req` removes the `wallBus` listener. Node garbage-collects the response object.
- **SSE connection failure:** Browser `EventSource` auto-retries with exponential backoff (spec default ~3s). The 10s poll keeps the wall alive in the meantime.
- **Rapid mutations:** The 100ms debounce in `notifyWall()` collapses bursts. Even without debounce, the `lastDataJson` guard in `render()` prevents redundant DOM work.
- **PM2 restart:** Clients reconnect automatically via EventSource retry. First poll within 10s catches up regardless.

## 8. Tests

### New file: `tests/sse-wall.test.js`

- SSE endpoint returns correct headers (`text/event-stream`, `no-cache`)
- SSE endpoint sends initial `:ok` comment
- Calling `notifyWall()` causes the SSE stream to emit a `refresh` event
- Multiple rapid `notifyWall()` calls within 100ms result in a single `refresh` event (debounce)
- Client disconnect cleans up the listener (wallBus listener count returns to baseline)

### Extend: `tests/routes-home.test.js` or `tests/routes-wall.test.js`

- Verify that `POST /api/assignments/:id/submit` triggers a wall bus event (import wallBus, listen for 'refresh')

Existing tests: 131. After Phase 5: ~137.

## 9. Tech notes

- `EventSource` is supported in all modern browsers. No polyfill needed.
- Cloudflare does support SSE pass-through by default. The `X-Accel-Buffering: no` header is a safety net in case any proxy layer tries to buffer the stream.
- The wall's existing `lastDataJson` comparison means that even if SSE and the poll both trigger `render()` within the same second, the DOM only rebuilds once (the second call sees identical JSON and bails early).
- Memory: each connected wall client holds one EventEmitter listener (a function reference). At family scale (1 wall client, maybe 2 during testing) this is negligible.
- The debounce timer is module-scoped. If `notifyWall()` is called, then 100ms passes with no further calls, the `'refresh'` event fires. If another `notifyWall()` arrives within 100ms, the timer resets. This is a standard trailing-edge debounce.

## 10. Acceptance test (manual, post-deploy)

1. Open the wall on the TV/monitor (`tally.thelopezfamily.org/wall`).
2. Open DevTools Network tab — confirm an EventSource connection to `/api/wall/events` is open.
3. On a phone, log in as a kid and complete a chore.
4. The wall should update within ~200ms (debounce + render), not 10 seconds.
5. Kill the PM2 process and restart — confirm the wall reconnects and resumes updating.
6. Approve a chore from the admin panel — wall updates instantly.
7. Post a new bonus from admin — bonus strip appears on wall instantly.

---

**Approved by user on 2026-05-27 via brainstorming session. Ready for implementation planning.**
