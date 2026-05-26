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

## Production (acutis-box)

1. Set a real session secret in `ecosystem.config.js` or via env.
2. Start under PM2:
   ```bash
   pm2 start ecosystem.config.js
   pm2 save
   ```
3. Add Cloudflare Tunnel route `tally.thelopezfamily.org` → `http://localhost:3007` via the Cloudflare Public Hostname tab (token-mode tunnel; not DNS-only).
4. On the Raspberry Pi kiosk, configure Chromium to launch in kiosk mode pointing at `https://tally.thelopezfamily.org/wall`.

## Spec
See `docs/superpowers/specs/2026-05-26-tally-design.md`.

## Phase status
- [x] Phase 1: Skeleton (this PR)
- [ ] Phase 2: Economy v1
- [ ] Phase 3: Anti-cheat
- [ ] Phase 4: Bonus board
- [ ] Phase 5: Realtime (SSE)
- [ ] Phase 6: Polish (streaks, confetti, dark-mode toggle, sick day, audit, undo, CSV)
- [ ] Phase 7: Notifications
