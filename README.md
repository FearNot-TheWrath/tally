# Tally

Household chores + allowance for the Lopez family.

## Dev
```bash
npm install
npm run dev
```
Open http://localhost:3007 (kid/parent app) or http://localhost:3007/wall (wall display).

## Test
```bash
npm test
```

## Production (acutis-box, deployed)

Currently deployed as PM2 process `tally` on port `3012` (3007 was taken by another service).

### One-time setup

1. Create `.env` at the project root with a random session secret. The file is gitignored.
   ```bash
   cd ~/projects/tally
   cat > .env <<EOF
   PORT=3012
   SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")
   NODE_ENV=production
   EOF
   chmod 600 .env
   ```

2. Start under PM2 and persist:
   ```bash
   pm2 start ecosystem.config.cjs
   pm2 save
   ```

3. Bootstrap a parent person (one-time, picker is empty otherwise):
   ```bash
   node -e "
   import('./src/db.js').then(({openDb}) => {
     const db = openDb('./tally.db');
     db.prepare(\"INSERT INTO people (name, role, avatar_color) VALUES ('Jeffrey','parent','#0F172A')\").run();
   });"
   ```
   Default admin PIN is `1234`. Change it from the admin Settings tab on first login.

### Cloudflare Tunnel

The local `cloudflared` CLI on acutis-box is only authorized for `spyministry.org`, so `tally.thelopezfamily.org` must be configured via the Cloudflare Zero Trust dashboard:

1. Zero Trust → Networks → Tunnels → open the tunnel that already serves `*.thelopezfamily.org` (the one used by `door.thelopezfamily.org`).
2. **Public Hostname** tab → Add a public hostname:
   - Subdomain: `tally`
   - Domain: `thelopezfamily.org`
   - Service: `HTTP` → `localhost:3012`
3. Save. DNS propagates within seconds. (Do NOT use the DNS tab to add a CNAME — token-mode tunnels need the ingress rule, not just DNS.)

### Pi kiosk

Configure Chromium to launch in kiosk mode at `https://tally.thelopezfamily.org/wall`.

### Operations

```bash
pm2 logs tally          # tail logs
pm2 restart tally       # restart after pulling new code
pm2 stop tally          # stop
```

## Spec & Plan

- Spec: [`docs/superpowers/specs/2026-05-26-tally-design.md`](docs/superpowers/specs/2026-05-26-tally-design.md)
- Phase 1 plan: [`docs/superpowers/plans/2026-05-26-tally-phase-1-skeleton.md`](docs/superpowers/plans/2026-05-26-tally-phase-1-skeleton.md)

## Phase status
- [x] Phase 1: Skeleton (deployed 2026-05-26, tag `v0.1.0-phase1`)
- [ ] Phase 2: Economy v1
- [ ] Phase 3: Anti-cheat (photo + approval workflow)
- [ ] Phase 4: Bonus board
- [ ] Phase 5: Realtime (SSE)
- [ ] Phase 6: Polish (streaks, confetti, dark-mode toggle, sick day, audit, undo, CSV)
- [ ] Phase 7: Notifications (Web Push)
