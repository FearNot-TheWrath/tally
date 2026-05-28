# Tally — Phase 7 (Web Push Notifications) Design

**Date:** 2026-05-27
**Project:** Tally
**Status:** Approved, ready for implementation planning
**Builds on:** Phase 6a (streaks + streak_warning_time), Phase 8 (banking + runPayoutIfDue), existing PWA (manifest + service worker)

---

## 1. Summary

Kids get browser push notifications for three events: their streak is at risk (evening, time-based), a payday deposit lands, and a new bonus is posted. Notifications are opt-in per device via a button on the kid home page. The `web-push` library handles VAPID signing and payload encryption. Event-driven notifications fire inline from existing endpoints; the time-based streak reminder fires from a once-a-minute `setInterval` scheduler. Parents do not get notifications in this phase.

## 2. Goals

1. **Streak-at-risk reminder** sent in the evening to kids who have an active streak but unfinished chores.
2. **Payday notification** when a kid's weekly earnings deposit into their bank.
3. **New bonus alert** to all kids when a parent posts a bonus (first-claim-wins, so speed matters).
4. **Opt-in per device** — no auto-prompt; a button the kid taps to enable.
5. **Graceful absence** — app runs identically when VAPID keys are not configured.

## 3. Non-goals (Phase 7)

- Parent notifications (approval requests, bonus claims)
- Morning chore nudges
- In-app notification center or history
- Per-notification-type opt-out (all-or-nothing for now)
- Rich notifications with images or action buttons
- Multi-process / clustered scheduler coordination (single PM2 process assumed)

## 4. Dependency

Add `web-push` to `package.json`. This is the one approved external dependency for the project. It handles RFC 8291 payload encryption and VAPID (RFC 8292) signing, which are impractical to hand-roll correctly. No other transitive bloat of concern.

## 5. Configuration

VAPID keypair generated once via `npx web-push generate-vapid-keys` (or a small one-off script). Stored in `.env`:

```
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:jeffrey@thelopezfamily.org
```

`isPushConfigured()` returns true only when all three are present. When absent (e.g. in tests or a fresh dev clone), every push code path becomes a no-op and the client "Turn on reminders" button is hidden.

## 6. Schema

### New migration: `008-push-subscriptions.sql`

```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id   INTEGER NOT NULL REFERENCES people(id),
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_push_person ON push_subscriptions(person_id);
```

- One kid may have multiple subscriptions (phone, tablet). `endpoint` is unique; re-subscribing the same browser updates the existing row (upsert on endpoint).
- `p256dh` and `auth` are the keys from the browser PushSubscription object.
- A subscription that returns HTTP 404 or 410 from the push service is deleted automatically (expired/unsubscribed).

## 7. Push module: `src/lib/push.js`

Wraps `web-push`. Exports:

- `isPushConfigured()` → boolean. True if all three VAPID env vars are set. Called once at module load to configure `web-push.setVapidDetails(...)`.
- `getPublicKey()` → string. The VAPID public key, for the client to subscribe.
- `saveSubscription(db, personId, subscription)` → upsert. `subscription` is `{ endpoint, keys: { p256dh, auth } }`. On endpoint conflict, updates person_id + keys.
- `removeSubscription(db, endpoint)` → delete by endpoint.
- `sendToPerson(db, personId, payload)` → async. Looks up all subscriptions for the kid; sends the encrypted notification to each. On 404/410, deletes that subscription. All errors are caught and logged, never thrown. No-op if `!isPushConfigured()`.

`payload` shape: `{ title, body, tag }`. `tag` lets the OS collapse duplicate notifications of the same kind.

## 8. Subscription endpoints: `src/routes/push.js`

Mounted at `/api`. All require kid auth (`requireRole('kid')`).

- `GET /api/push/vapid-key` → `{ key: getPublicKey() }`. Returns 503 if push not configured.
- `POST /api/push/subscribe` → body is the browser PushSubscription JSON. Calls `saveSubscription`. Returns `{ ok: true }`.
- `POST /api/push/unsubscribe` → body `{ endpoint }`. Calls `removeSubscription`. Returns `{ ok: true }`.

## 9. Event-driven triggers

Inline calls to `sendToPerson`, wrapped so a push failure never breaks the action:

- **New bonus** (`POST /api/admin/bonuses`, after the successful insert): notify every kid (`role='kid'`) with `{ title: 'New bonus!', body: '[title] · +[points] pts', tag: 'bonus' }`.
- **Payday deposit** (inside `runPayoutIfDue`, when a deposit with `amount_cents > 0` is inserted for a kid): notify that kid with `{ title: 'Payday!', body: '$X.XX added to your bank', tag: 'payday' }`.

## 10. Time-based trigger: scheduler

### New module: `src/lib/scheduler.js`

Exports:

- `streakReminderDue(db, nowDate)` → array of `{ personId, streakDays }` for kids who should get a streak-at-risk reminder right now. Pure function: reads `streak_warning_time`, checks each kid via `streakAtRisk`, returns those at risk. Testable without timers.
- `startScheduler(db)` → starts a `setInterval` (60s) that, each tick:
  1. Computes the current HH:MM.
  2. If the current minute equals `streak_warning_time` (the reminder fires once when the clock reaches the configured minute), calls `streakReminderDue` and sends a notification to each returned kid: `{ title: 'Streak at risk!', body: 'Your [N] day streak ends tonight. Finish your chores!', tag: 'streak' }`.
  3. Uses an in-memory `Set` of `personId:YYYY-MM-DD` keys to prevent duplicate sends within the same day. The set is pruned when the date changes.

`startScheduler` is called once from the server entry point (`src/index.js`), NOT from `buildApp`, so the test suite (which builds apps) never spawns timers.

## 11. Service worker: `public/sw.js`

Add two event listeners to the existing service worker:

- `push` — parse `event.data.json()` into `{ title, body, tag }`, call `self.registration.showNotification(title, { body, tag, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png' })`. Wrapped in `event.waitUntil(...)`.
- `notificationclick` — `event.notification.close()`, then focus an existing app window if one is open, else `clients.openWindow('/')`. Wrapped in `event.waitUntil(...)`.

The existing install/activate/fetch handlers are unchanged. The service worker version constant is bumped so browsers pick up the new code.

## 12. Client subscription: `public/js/lib/push-client.js`

Exports `enablePush()`:

1. If `!('Notification' in window)` or `!('serviceWorker' in navigator)`, return `{ ok: false, reason: 'unsupported' }`.
2. Fetch `GET /api/push/vapid-key`. If 503, return `{ ok: false, reason: 'not-configured' }`.
3. Request permission via `Notification.requestPermission()`. If not `granted`, return `{ ok: false, reason: 'denied' }`.
4. Get the service worker registration, call `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` (key converted from base64url to Uint8Array via a helper).
5. POST the subscription to `/api/push/subscribe`. Return `{ ok: true }`.

Also exports `pushStatus()` → `'enabled' | 'default' | 'denied' | 'unsupported'` based on `Notification.permission` and existing subscription, for the button state.

## 13. Kid home UI

In the header of the kid home page, a small "Turn on reminders" button shown only when `pushStatus()` is `'default'` (permission not yet decided) AND push is configured server-side.

- Tapping it calls `enablePush()`. On success, the button disappears.
- If status is `'denied'`, show a muted "Reminders blocked" label instead (the kid must re-enable in browser settings; we don't nag).
- If status is `'enabled'` or push isn't configured, show nothing.

No auto-prompt on page load (browsers penalize that and it's poor UX). Strictly tap-to-enable.

## 14. Tests

### New file: `tests/lib-push.test.js`

- `isPushConfigured` returns false when env vars absent
- `saveSubscription` inserts a new subscription
- `saveSubscription` on the same endpoint updates rather than duplicates (only one row)
- `removeSubscription` deletes by endpoint
- `sendToPerson` is a safe no-op when push not configured (does not throw)

### New file: `tests/routes-push.test.js`

- `GET /api/push/vapid-key` returns 503 when not configured
- `POST /api/push/subscribe` saves a subscription (mock body)
- `POST /api/push/unsubscribe` removes a subscription
- Endpoints reject non-kid auth

### New file: `tests/lib-scheduler.test.js`

- `streakReminderDue` returns kids who are at risk
- `streakReminderDue` returns empty when no kid is at risk
- `streakReminderDue` excludes kids with streak 0 or frozen today

`web-push` is not invoked in tests (no VAPID keys in the test env, so `sendToPerson` no-ops). We test our wrapper and scheduler logic, not the library's encryption.

Existing tests: 153. After Phase 7: ~165.

## 15. Tech notes

- iOS Safari supports Web Push only for installed PWAs (added to home screen) as of iOS 16.4+. The kids are on phones; they may need to "Add to Home Screen" first. This is a platform constraint, documented for the acceptance test, not something the app can work around.
- The `setInterval` scheduler runs in the single PM2 process. If the process restarts, the in-memory dedup set resets, but the once-per-minute equality check on `streak_warning_time` means at most one extra send right around a restart at the exact warning minute. Acceptable.
- `sendToPerson` swallows all errors by design: a notification is a nice-to-have, never a reason to fail a deposit or bonus post.
- VAPID keys are secrets. They go in `.env` (gitignored), never committed. The acceptance test includes generating them.

## 16. Acceptance test (manual, post-deploy)

1. Generate VAPID keys, add to `.env`, restart PM2.
2. On a kid's phone, add Tally to the home screen (iOS requirement). Open it.
3. Tap "Turn on reminders". Grant permission. Button disappears.
4. As parent, post a new bonus. The kid's phone should receive a "New bonus!" notification within seconds.
5. Set `streak_warning_time` to one minute from now. Ensure the kid has an active streak and an unfinished chore. Wait. The kid should get a "Streak at risk!" notification.
6. Trigger a payday (set payout to just past) and open the app. The kid should get a "Payday!" notification.
7. Tap a notification — the app should open/focus.
8. Verify the app still works normally with VAPID keys removed (button hidden, no errors).

---

**Approved by user on 2026-05-27 via brainstorming session. Ready for implementation planning.**
