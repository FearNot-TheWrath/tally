# Tally

Self-hosted household chores and allowance tracker for the Lopez family. Kids mark off chores on their phones, a wall-mounted display shows live family progress, and a parent admin runs the whole economy: weighted points, weekly pay, bonuses, streaks, and a built-in allowance bank.

Built as a zero-build, dependency-light app: Node, Express, SQLite, and vanilla JS. No framework, no bundler.

---

## What it does

**Kids (phone PWA)**
- See today's chores and anything overdue; mark them done.
- Three completion modes per chore: honor (tap done, with undo), photo (snap a picture), or approval (submit for a parent to review).
- Earn weighted points that roll up to a weekly target and a projected payout.
- Claim parent-posted bonus chores (first claim wins).
- Steal a sibling's unclaimed non-school chore after the daily unlock time (4 PM by default).
- Track a personal streak, get an evening "streak at risk" nudge, and celebrate with confetti when the streak grows.
- View their bank balance and transaction history.
- Opt in to push notifications (streak at risk, payday, new bonus).

**Wall display**
- House progress for the day, plus a column per kid: points, percent, streak, and bank balance.
- Auto-scrolling task lists, a bonus board strip, and a "streak leader" banner.
- Updates instantly over Server-Sent Events (with a 10s poll as a fallback), and fires confetti when any kid extends a streak.

**Parents (admin)**
- **Today** — at-a-glance per-kid progress, projected pay, and bank balance; tap a kid to expand their task list and excuse a chore for the day.
- **Day review** — see any day's photo/approval submissions and accept or reject them.
- **Approvals** — the pending review queue.
- **Bonus board** — post and cancel bonus chores.
- **Bank** — per-kid balances, transaction history, and manual add/deduct adjustments.
- **People** — manage kids and parents, weekly target, base pay, bonus rate, and sick-day/vacation freeze ranges.
- **Chores** — recurrence, effort weight (1-5), anti-cheat mode, and a school-work flag.
- **Settings** — steal unlock time, streak warning time, payout day/time.

**Economy model**
- Each chore has an effort weight (1-5). A kid's weekly points are `done_weight / total_weight × weekly_target`, with the rest of the week forecast from recurrence rules so the percentage is meaningful from day one.
- Hitting the weekly target pays `base_pay`; points past target pay a per-point `bonus_rate`. Stolen-in and bonus chores are extra credit on top.
- Earnings auto-deposit into each kid's bank on the configured payout day; parents can adjust balances by hand with a note.
- Sick-day/vacation freezes hold a kid's streak without penalty; parents can also excuse a single chore for a single day so it drops out of streak and pay math.

---

## Tech stack

- **Runtime:** Node 20+ (ESM)
- **Server:** Express 5
- **Database:** SQLite via better-sqlite3 (WAL mode), file-based at `./tally.db`
- **Frontend:** vanilla JS single-page app + a separate wall page; PWA with a service worker. No build step.
- **Images:** sharp (photo resize + EXIF strip)
- **Push:** web-push (VAPID)
- **Realtime:** Server-Sent Events
- **Process manager:** PM2

---

## Quick start (development)

```bash
npm install
npm run dev
```

- Kid/parent app: http://localhost:3007
- Wall display: http://localhost:3007/wall

`npm run dev` runs the server with `--watch`. The SQLite database and its migrations are created automatically on first boot.

### Tests

```bash
npm test
```

Runs the `node:test` suite (no external test runner). Tests use in-memory databases, so they never touch your real data, and they run identically whether or not push is configured.

---

## Configuration

Configuration is read from environment variables. In development you can export them; in production they live in a gitignored `.env` loaded by Node's `--env-file` flag (wired up in `ecosystem.config.cjs`).

| Variable | Required | Purpose |
|----------|----------|---------|
| `PORT` | no (default 3007) | HTTP port |
| `SESSION_SECRET` | yes (in prod) | Cookie session signing key |
| `NODE_ENV` | no | `production` in prod |
| `VAPID_PUBLIC_KEY` | no | Web Push public key. Push is disabled (gracefully no-ops) if unset. |
| `VAPID_PRIVATE_KEY` | no | Web Push private key |
| `VAPID_SUBJECT` | no | `mailto:` contact for the push service |

Generate a VAPID keypair with:

```bash
node -e "import('web-push').then(m => { const k = m.default.generateVAPIDKeys(); console.log('VAPID_PUBLIC_KEY=' + k.publicKey + '\nVAPID_PRIVATE_KEY=' + k.privateKey); })"
```

Runtime settings that parents change in the UI (steal unlock time, streak warning time, payout day/time, admin PIN) live in the `settings` table, not in env.

---

## Project layout

```
server.js                 Entry point: opens DB, builds app, starts generator + payout/streak schedulers
src/
  app.js                  Express app assembly + route mounting
  db.js                   SQLite open + migration runner
  auth.js                 Session + role guards (requireRole)
  migrations/             Numbered .sql files, applied in order on boot
  lib/                    Pure-ish domain logic:
    points.js             Weighted points + projected pay
    streak.js             Streak walk, at-risk, freeze
    payout.js             Lazy weekly auto-deposit
    events.js             In-process bus for SSE wall refresh
    scheduler.js          Once-a-minute streak-reminder timer
    push.js               web-push wrapper (no-ops without VAPID)
    assignments.js        Daily assignment generation + recurrence
    photo.js, dates.js, retention.js
  routes/
    home.js, wall.js, push.js, auth.js
    admin/                today, day-review, approvals, bonuses, bank,
                          assignments, people, chores, settings
public/                   Static SPA, wall page, service worker, PWA manifest
docs/superpowers/         Per-feature design specs and implementation plans
tests/                    node:test suites
```

**Design philosophy:** state that can be derived is recomputed on read rather than cached. Streaks, the weekly points/pay forecast, and the weekly payout are all pure functions over the assignment + transaction history, evaluated lazily when an API endpoint is hit. There is no cron and minimal denormalization, which keeps the data model honest and the code easy to reason about.

---

## Production deployment

Deployed on the home server (`acutis-box`) as a PM2 process named `tally` on port `3012`, fronted by a Cloudflare Tunnel at `https://tally.thelopezfamily.org`.

### One-time setup

1. Create `.env` at the project root (gitignored):
   ```bash
   cd ~/projects/tally
   cat > .env <<EOF
   PORT=3012
   SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")
   NODE_ENV=production
   EOF
   chmod 600 .env
   ```
   Add the three `VAPID_*` lines here too if you want push notifications.

2. Start under PM2 and persist across reboots:
   ```bash
   pm2 start ecosystem.config.cjs
   pm2 save
   ```

3. Seed a parent so the login picker isn't empty:
   ```bash
   node -e "
   import('./src/db.js').then(({openDb}) => {
     const db = openDb('./tally.db');
     db.prepare(\"INSERT INTO people (name, role, avatar_color) VALUES ('Jeffrey','parent','#0F172A')\").run();
   });"
   ```
   The default admin PIN is `1234`; change it from the admin Settings tab on first login.

### Cloudflare Tunnel

`tally.thelopezfamily.org` rides the existing cert-based `cloudflared` tunnel on the box (the same one serving the other `*.thelopezfamily.org` hostnames):

1. Add an ingress rule in `/etc/cloudflared/config.yml` mapping `tally.thelopezfamily.org` to `http://localhost:3012`, above the catch-all `service: http_status:404`.
2. Restart the tunnel: `sudo systemctl restart cloudflared`.
3. Add a DNS `CNAME` for `tally` pointing at the tunnel's `<TUNNEL_ID>.cfargotunnel.com` target.

### Pi kiosk

Point Chromium in kiosk mode at `https://tally.thelopezfamily.org/wall`.

### Operations

```bash
pm2 logs tally           # tail logs
pm2 reload tally         # zero-downtime reload after pulling new code
pm2 reload tally --update-env   # reload and re-read .env (e.g. after adding VAPID keys)
pm2 restart tally        # hard restart
```

After deploying schema changes, migrations run automatically on the next boot. Back up `tally.db` before migrations that recreate tables.

---

## Delivery history

Each feature ships as a phase: a design spec in `docs/superpowers/specs/`, an implementation plan in `docs/superpowers/plans/`, then a tagged release.

| Tag | Phase |
|-----|-------|
| `v0.1.0-phase1` | Skeleton (schema, auth, kid/wall/admin shells) |
| `v0.2.0-phase2a` | Weighted points + chore stealing |
| `v0.3.0-phase3` | Anti-cheat (photo + approval workflow) |
| `v0.4.0-phase4` | Bonus board |
| `v0.5.0-phase5` | Realtime wall via SSE |
| `v0.6.0-phase6a` | Streaks + sick-day freeze |
| `v0.6.1-phase6b` | Streak confetti |
| `v0.7.0-phase7` | Web Push notifications |
| `v0.8.0-phase8` | Banking + weekly auto-payout |
| `v0.9.0-phase9` | Chore excusals |

### Planned

- **School-work deadline** — school chores not finished by a configurable deadline (default 4 PM) forfeit their points and break that day's streak, while the chore still has to be completed. Designed, not yet built.

---

## Wall calendar overlay (Google Calendar via OAuth)

The wall's weather panel shows today + tomorrow events from one or more Google
Calendars. To set this up:

1. **Create OAuth credentials in Google Cloud Console.**
   - Visit https://console.cloud.google.com, create or pick a project.
   - APIs & Services > Library: enable **Google Calendar API**.
   - APIs & Services > Credentials > Create credentials > OAuth client ID
     > Web application.
   - Authorized redirect URI: `https://your-host/api/auth/google/callback`.
2. **Drop the credentials in `.env`.**
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=https://your-host/api/auth/google/callback
   ```
3. **Restart Tally:** `pm2 restart tally --update-env`.
4. **Connect from the admin Wall tab.** Open admin, navigate to the Wall tab,
   scroll to the Calendar card, click **Connect Google Calendar**. Google asks
   you to consent to read-only calendar access. After consent you'll be
   redirected back to the Wall tab where a checklist of your calendars appears.
5. **Pick which calendars feed the wall.** Tick the boxes; the overlay renders
   their events within ~5 minutes.

If Google revokes access (you delete the OAuth grant or rotate the client
secret), the overlay collapses and the admin tab shows the Connect button
again. The refresh token in the DB is encrypted with a key derived from
`SESSION_SECRET`; if that secret changes you must reconnect.

---

## License

Private family project. Not licensed for redistribution.
