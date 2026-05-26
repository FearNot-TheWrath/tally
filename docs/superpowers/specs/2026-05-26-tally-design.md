# Tally — Design Spec

**Date:** 2026-05-26
**Project:** Tally (household chores + allowance, Lopez family)
**Status:** Approved, ready for implementation planning
**Supersedes:** Lopez Chores v1 ("Home Base") at `~/projects/Lopez Chores/` (greenfield rebuild, no data migration)

---

## 1. Summary

Tally is a self-hosted family chores + allowance app for the Lopez household (3 kids: Christopher 9, Olivia 12, Gabriel 15, plus parents). It runs on three surfaces:

1. **Wall display** — always-on kiosk view on a Raspberry-Pi-driven monitor. Shows today + overdue per kid, family banner with house progress, streaks. Read-only.
2. **Phone PWA** — per-kid home screen with target progress, points, today's tasks, bonus board, photo capture for flagged chores. Identity via tap-your-face profile picker, sticky cookie.
3. **Parent admin** — full CRUD over chores, kids, assignments, approvals, weekly payouts, bank, ledger, and reports.

The visual system is "Style C": light shell, dark gradient hero card (Stripe Dashboard feel), JetBrains Mono for all numerics. Per-device dark mode toggle. The aesthetic intentionally reads "banky/techie," not kid-app.

Points convert to real allowance. Each kid has a weekly target. Hitting the target earns base pay; each point over target earns a per-kid bonus rate. Sunday is the settle day. Kids can cash out or deposit to a personal bank balance.

## 2. Goals

1. **Glanceable accountability.** Anyone walking past the wall sees who has what left.
2. **Real money mechanics.** Per-kid weekly targets, base pay, bonus rates, late tax, savings bank, full ledger.
3. **Anti-shenanigans.** Per-chore anti-cheat flag (honor, photo-required, approval-required) so important chores get verified.
4. **Banky/techie feel.** Premium fintech aesthetic, not a kids' chore app aesthetic.
5. **Two-parent admin.** Both Jeffrey and spouse manage the system. All actions audited.

## 3. Non-goals

- Multi-family / multi-tenant. Single household only.
- Mobile app stores. PWA only.
- Integrations with banks, Venmo, etc. Payout is recorded in-app; cash/transfer happens offline.
- Backward compatibility with v1 (Home Base). No data migration.

## 4. Users and identity

### Roles

| Role | Identity flow | Capabilities |
|---|---|---|
| **Kid** | Tap face on profile picker → sticky device cookie. No password. | View own home, check off own chores, claim bonus chores, capture photos, request bank withdrawal |
| **Parent** | Tap "Parent" tile → admin PIN screen → sticky cookie with parent role | Full admin access. Both parents share the same parent role |
| **Wall display** | Special URL `/wall` → no auth → family read-only view | Read-only family view |

### Identity rules

- Sticky cookie persists indefinitely on a device. Logout button available.
- First-tap-wins: roster picker is the device-binding action. Trust-based for kids; no PINs in MVP. (Future: optional per-kid PIN.)
- Wall display URL `/wall` requires no auth; assume the device is physically inside the home.
- Parent PIN is stored in `settings` (scrypt hashed). Default `1234`, must be changed on first parent login.
- Sessions table records device fingerprint and last-seen for audit visibility.

## 5. Surfaces

### 5.1 Wall display (`/wall`)

**Layout** (the "Layout B" we picked):

- **Header**: "The Lopez House · Tuesday, May 26" left-aligned, current time right-aligned.
- **Family banner**: dark gradient card (Style C hero treatment) with house progress percentage (large JetBrains Mono numeric) on the left and per-kid stat tiles on the right (X/Y completed today).
- **Three columns**: one per kid, in a stable order (Gabriel, Olivia, Christopher by age). Each column shows:
  - Kid name + avatar tile
  - Points this week + streak (mono numerics)
  - Today's chores listed: title + point value. Done = struck-through gray. Overdue = red row.

**Behavior**:

- Auto-refreshes via SSE on `assignment.updated`, `bonus.claimed`, `weekly.settled`.
- When a kid checks off on phone, the affected row briefly pulses with a green tick animation, then settles into the done state.
- Time updates every minute. Date rolls at midnight.
- Falls back to polling every 30s if SSE drops.

### 5.2 Phone PWA (`/`)

**First load**: roster picker. Avatar tiles for each family member. Tap → cookie set → home.

**Kid home**:

- Header: greeting ("Gabriel") + avatar.
- Dark gradient hero card (the Style C signature): "This week" label, big mono number `72 / 150`, gradient progress bar, row underneath: `12 day streak · $7.20 projected`.
- Two mini-cards side-by-side: **Bank** (`$24.30`) and **Pending review** (`1`).
- "Today" section header → list of chore rows (title + point value + status icon).
- "Bonus board" section if any unclaimed bonus chores exist → tap to claim.
- Bottom nav: Home, History (ledger), Bank, Settings.

**Check-off flow**:

- Honor chore: tap → optimistic update → confetti overlay with "+10" and "3 left today" → SSE notifies wall.
- Photo-flagged chore: tap → camera opens (HTML `<input type="file" capture="environment">`) → capture → uploaded with progress → status moves to `submitted`. Wall shows a "pending" badge until parent approves.
- Approval-flagged chore: tap → no photo, but status moves to `submitted` with optional note. Parent approves remotely.

**Settings**: theme toggle (light / dark / system), notification permissions, sign-out (clears cookie).

### 5.3 Parent admin (`/admin`)

Tabbed single-page admin. Mobile-first; same layout on phone and desktop.

| Tab | Content |
|---|---|
| **Dashboard** | Pending approvals count, today's % per kid, overdue items, this week's projected payouts, alerts (no check-off in 24h, streak about to break) |
| **Chores** | Library CRUD. Title, description, points, recurrence (daily/weekly/biweekly/monthly + days-of-week), due-time, anti-cheat flag, late-tax %, photo prompt text, default assignees, tags |
| **Assign** | Grid (kids × chores) with toggles. Bulk operations (assign all morning chores to all kids). Copy chore to another kid in one tap |
| **Approvals** | Submitted-pending queue with inline photo preview. Approve / reject (with note) / approve-with-adjusted-points |
| **Bonus board** | Post one-off chores with custom point values. View claimed/unclaimed status. Cancel unclaimed |
| **People** | Each kid card: name, dob, avatar color, `weekly_target_pts`, `base_pay_cents`, `bonus_rate_cents`, current streak, current bank balance. Parents listed with role badges |
| **Settle** | Sunday review. Each kid: points earned, target, % to target, base pay calc, bonus calc, total. Approve & pay (writes ledger entry). History tab shows past weeks |
| **Ledger** | Chronological feed of every earning, payout, adjustment, deposit. Filterable by kid, kind, date range. CSV export |
| **Bank** | Per-kid balance, withdraw request queue, manual deposit/adjustment with required reason |
| **Reports** | Completion rate (week/month/all-time), week-over-week trend, most-skipped chores, longest streaks |
| **Settings** | Admin PIN, payout day, payout time, reminder push time, late-tax default %, photo retention days, dark mode default, backup/restore, VAPID keys, app-wide notifications config |

**Robustness features**:

- **Dual-parent**: both parents share the parent role. Every parent action is logged in `admin_audit` (who, what, when, before, after).
- **Soft-delete only** on chores and ledger entries. Hard delete impossible by design.
- **Point adjustments** require a `reason` field. Shows in kid's ledger as "Adjustment: <reason> by <parent>".
- **30-second undo** banner after destructive actions.
- **Sick day / freeze week** flag per kid pauses recurring chores and freezes the streak (no break, no progress) for a date range.
- **Two-tap confirms** for settled-week edits, payout reversals, ledger purges.
- **Backup**: nightly cron writes `tally-YYYY-MM-DD.db.gz` to `~/backups/`. Last 30 kept. Restore from latest requires typing the kid's birthdate as confirmation.
- **CSV export** on every list view.

## 6. Economy rules

**Variables (per kid, configurable in admin)**:

- `weekly_target_pts` — points required to hit target this week (e.g. Gabriel 150, Olivia 100, Christopher 60)
- `base_pay_cents` — cents earned if target hit (e.g. Gabriel $10 = 1000)
- `bonus_rate_cents` — cents per point above target (e.g. Gabriel 10 = $0.10/pt)
- `late_tax_pct` — global default, per-chore override possible (default 50%)

**Earning flow**:

1. Kid completes chore. For `honor`, status → `done` immediately. For `photo`/`approval`, status → `submitted`; only becomes `done` after parent approves.
2. On the `submitted → done` transition (or directly on completion for `honor`), `points_earned` is calculated: full points if on time, `points × (1 - late_tax_pct/100)` if late. Parent may override `points_earned` at approval time.
3. Ledger entry recorded: `kind = earn`, `points`, `cents = 0`, `ref_assignment_id`. Entries are only written on `done`, never on `submitted`.
4. Weekly running total updates in `weekly_summary` (row created lazily Monday 00:00 local for that week).

**Sunday settle flow** (manual, parent triggers in admin):

1. For each kid:
   - `points_total` = sum of `earn` ledger entries this week
   - If `points_total >= weekly_target_pts`: `base_cents = base_pay_cents`, `bonus_cents = (points_total - weekly_target_pts) * bonus_rate_cents`
   - Else: `base_cents = (points_total / weekly_target_pts) * base_pay_cents`, `bonus_cents = 0`
   - `payout_cents = base_cents + bonus_cents`
2. Parent reviews, can adjust per-kid before approving.
3. On approve:
   - Kid chooses cash vs bank deposit on their phone OR parent chooses for them in admin.
   - Ledger entry: `kind = payout` (cash) or `kind = deposit_to_bank`.
   - `weekly_summary.settled_at` set.

**Bank withdrawal**:

- Kid taps "Withdraw $X" on phone (Bank tab) → request queued in admin.
- Parent confirms → ledger entry `kind = payout` with negative bank delta.

**Late tax**:

- "Late" means `done` (or `submitted`) timestamp is after the chore's `due_date` end-of-day.
- For recurring chores without explicit due_date, the day-of-week schedule determines due date; "late" = done after midnight of the scheduled day.

## 7. Anti-cheat (per-chore `anti_cheat` flag)

| Flag | Flow | Use case |
|---|---|---|
| `honor` | tap done → status `done` immediately → points credit | Make bed, simple recurring stuff |
| `photo` | tap done → camera opens → photo captured → status `submitted` → photo stored at `./uploads/YYYY-MM/<assignment_id>.jpg` → parent reviews in approvals tab → approve → `done` (or reject → back to pending) | Vacuumed room, mowed lawn |
| `approval` | tap done → status `submitted` (no photo required) → parent approves remotely → `done` | Big chores where photo isn't useful, e.g. "help with dinner" |

Photos auto-purge after configurable retention period (default 90 days). EXIF stripped on upload.

## 8. Bonus chores (one-off, first-claim-wins)

- Parent posts in admin: title, description, points, optional photo/approval flag.
- Appears on the wall's "Bonus board" section (added at bottom when active) and on each kid's home under "Bonus board".
- First kid to tap "Claim" owns it — assignment row created with that kid.
- Once claimed, it shows "Claimed by <name>" on the wall and disappears from other kids' bonus boards.
- Bonus chores have no recurrence and no schedule. They're one-shot.
- Parent can cancel unclaimed bonuses anytime.

## 9. Realtime (SSE)

**Endpoint**: `GET /events` returns `text/event-stream`. Authenticated for kids/parents; unauthenticated for wall (uses query param `?role=wall` from the kiosk URL). Events filtered by role and person_id.

**Events broadcast**:

- `assignment.updated` — when status changes (pending → submitted → done, etc.). Payload includes assignment id, person id, status, points_earned.
- `bonus.claimed` — when a bonus chore is claimed. Payload: chore id, claimed_by person id.
- `weekly.settled` — when parent approves a Sunday settle. Payload: week_start.
- `approval.requested` — when a kid submits a photo/approval-flagged chore. Pushed to parents only.

**Client behavior**:

- Wall display subscribes always; re-renders affected column on each event.
- Kid phones subscribe; only act on events affecting their own person id.
- Parent admin subscribes; updates approvals badge, dashboard counts.
- 30-second polling fallback if SSE disconnects.

## 10. Notifications (Web Push)

**VAPID keys** generated once, stored in `.env` as `VAPID_PUBLIC` / `VAPID_PRIVATE`.

**Subscribe**: service worker registers, sends subscription to `POST /api/push/subscribe`. Stored in `push_subscriptions` table.

**Push events**:

| Event | Recipients | Trigger |
|---|---|---|
| Daily reminder | Kids with chores remaining | Configurable time (default 4 PM local), one push per kid |
| New chore assigned | Affected kid | When parent assigns new chore |
| Approval needed | All parents | When a `submitted` assignment lands |
| Weekly settle ready | All parents | Sunday evening (configurable time) |

Per-recipient toggle in Settings.

## 11. Visual system (Style C)

**Type**:
- UI: Inter (loaded from Google Fonts)
- Numerics: JetBrains Mono (all points, dollars, dates, streaks)

**Palette (light)**:
- bg `#FCFCFD`, card `#FFFFFF`, ink `#0F172A`, muted `#64748B`, border `#E2E8F0`
- Money green `#10B981`
- Overdue red `#B91C1C`
- Accent purple gradient `#6366F1 → #8B5CF6` (avatar tiles)

**Palette (dark)**:
- bg `#0A0A0A`, card `#171717`, ink `#E5E5E5`, muted `#737373`, border `#262626`
- Money green `#22C55E`
- Overdue red `#F87171`

**Hero card** (the brand signature, always dark regardless of theme):
- Gradient `#0F172A → #1E293B` with a soft purple radial glow in the top-right corner
- JetBrains Mono number, large, tight letter-spacing
- Used on phone home and parent dashboard

**Theme toggle**:
- Light / Dark / System (defaults to System).
- For kid phones and parent admin: stored in `localStorage` per device.
- For wall display: stored server-side in `settings` table under key `wall_theme`, since the wall is shared and may be set by either parent from anywhere. Wall fetches its theme on each SSE connect.

## 12. Data model (new SQLite)

```sql
-- People
CREATE TABLE people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  dob TEXT,                           -- ISO date
  role TEXT NOT NULL,                 -- 'kid' | 'parent' | 'wall'
  avatar_color TEXT NOT NULL,         -- hex
  weekly_target_pts INTEGER DEFAULT 0,
  base_pay_cents INTEGER DEFAULT 0,
  bonus_rate_cents INTEGER DEFAULT 0,
  bank_cents INTEGER DEFAULT 0,
  streak_days INTEGER DEFAULT 0,
  streak_last_date TEXT,
  freeze_start TEXT,                  -- sick day / pause
  freeze_end TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Chores (the library)
CREATE TABLE chores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  points INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'recurring',  -- 'recurring' | 'bonus' | 'one-off'
  recurs TEXT NOT NULL DEFAULT 'none',     -- 'none' | 'daily' | 'weekly' | 'biweekly' | 'monthly'
  recurs_days TEXT DEFAULT '',              -- CSV of 0-6 for selected days
  recurs_anchor TEXT,
  due_time TEXT,                            -- HH:MM optional
  anti_cheat TEXT NOT NULL DEFAULT 'honor', -- 'honor' | 'photo' | 'approval'
  late_tax_pct INTEGER,                     -- override of global default
  photo_prompt TEXT DEFAULT '',
  default_assignees TEXT DEFAULT '',        -- CSV of person_ids
  deleted_at TEXT,                          -- soft-delete
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Assignments (a chore due to a kid on a date)
CREATE TABLE assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chore_id INTEGER NOT NULL,
  person_id INTEGER,                        -- null for unclaimed bonus
  due_date TEXT NOT NULL,                   -- ISO date
  status TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'in-progress' | 'submitted' | 'done' | 'rejected' | 'expired'
  submitted_at TEXT,
  approved_at TEXT,
  approved_by INTEGER,                      -- parent person_id
  photo_path TEXT,
  note TEXT DEFAULT '',
  points_earned INTEGER DEFAULT 0,
  late INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bonus claims (first-claim-wins on bonus chores)
CREATE TABLE bonus_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chore_id INTEGER NOT NULL UNIQUE,
  person_id INTEGER NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Ledger (every money or point movement)
CREATE TABLE ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                       -- 'earn' | 'bonus' | 'adjust' | 'payout' | 'deposit_to_bank' | 'withdraw_from_bank'
  points INTEGER DEFAULT 0,
  cents INTEGER DEFAULT 0,
  week_start TEXT,                          -- ISO date (Monday)
  ref_assignment_id INTEGER,
  reason TEXT DEFAULT '',                   -- required for 'adjust'
  created_by INTEGER,                       -- parent person_id, null for system
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Weekly settle summaries
CREATE TABLE weekly_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL,
  week_start TEXT NOT NULL,                 -- ISO date (Monday)
  points_total INTEGER DEFAULT 0,
  points_target INTEGER DEFAULT 0,
  base_cents INTEGER DEFAULT 0,
  bonus_cents INTEGER DEFAULT 0,
  payout_cents INTEGER DEFAULT 0,
  payout_method TEXT,                       -- 'cash' | 'bank'
  settled_at TEXT,
  settled_by INTEGER,                       -- parent person_id
  UNIQUE(person_id, week_start)
);

-- Sessions (device cookies)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                      -- random token
  person_id INTEGER NOT NULL,
  device_fp TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Push subscriptions
CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  keys_p256dh TEXT NOT NULL,
  keys_auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audit log
CREATE TABLE admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  target_table TEXT,
  target_id INTEGER,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Settings
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

## 13. API surface (sketch)

All endpoints under `/api`. JSON request/response. Auth via signed session cookie.

```
GET    /api/auth/picker              -- list of people for the picker
POST   /api/auth/login               -- { person_id } or { person_id, pin } for parent
POST   /api/auth/logout

GET    /api/me                       -- current person + summary
GET    /api/home                     -- kid's home view payload (today, bonus, hero stats)
GET    /api/wall                     -- wall display payload (all kids today + overdue)

POST   /api/assignments/:id/done     -- mark done (honor)
POST   /api/assignments/:id/submit   -- submit with optional photo (photo/approval)
POST   /api/assignments/:id/approve  -- parent approve
POST   /api/assignments/:id/reject   -- parent reject with note

POST   /api/bonus/:chore_id/claim    -- kid claims a bonus

GET    /api/admin/chores
POST   /api/admin/chores
PATCH  /api/admin/chores/:id
DELETE /api/admin/chores/:id         -- soft delete

GET    /api/admin/people
POST   /api/admin/people
PATCH  /api/admin/people/:id

GET    /api/admin/approvals
GET    /api/admin/ledger?person_id=&kind=&from=&to=
GET    /api/admin/reports

GET    /api/admin/settle/:week_start -- preview settle for week
POST   /api/admin/settle/:week_start -- approve + record payouts

POST   /api/admin/bank/deposit       -- manual deposit
POST   /api/admin/bank/withdraw      -- approve a withdrawal request

GET    /api/admin/audit
GET    /api/admin/backup             -- streams tally.db.gz
POST   /api/admin/backup/restore     -- with safety word

GET    /api/push/vapid               -- public key
POST   /api/push/subscribe
DELETE /api/push/subscribe

GET    /events                       -- SSE stream
```

## 14. Stack and deployment

- **Runtime**: Node 20+
- **Server**: Express 5, better-sqlite3, web-push, multer (photo upload), cookie-session, sharp (photo EXIF strip + resize)
- **Frontend**: Vanilla JS SPA (no build step), single `index.html` + ES modules. PWA manifest + service worker
- **Realtime**: native EventSource (SSE) on `/events`. No Socket.io
- **Auth**: signed session cookie (`tally_session`)
- **Photos**: stored on disk at `./uploads/YYYY-MM/`, served via authenticated `/uploads/...` endpoint
- **DB**: `./tally.db` at project root
- **Deploy**: PM2 on acutis-box, port `3007`, Cloudflare Tunnel → `tally.thelopezfamily.org`
- **Wall kiosk**: Raspberry Pi → Chromium kiosk mode → `tally.thelopezfamily.org/wall`. Pi auto-boots into this URL
- **Backups**: nightly cron → `~/backups/tally-YYYY-MM-DD.db.gz`. Last 30 retained
- **Project location**: `~/projects/tally/`

## 15. Build phases (each shippable)

1. **Skeleton** — Express server, DB schema + migrations, profile picker, sticky cookie auth, basic kid home (today list, mark done honor-only), wall display layout at `/wall`, parent admin People + Chores tabs (CRUD only)
2. **Economy v1** — points on chores, per-kid targets/rates, ledger entries on `earn`, weekly_summary lazy creation, Settle tab MVP (preview + approve + record payout)
3. **Anti-cheat** — per-chore flag, photo capture from phone, multer upload + sharp processing, Approvals tab in admin (approve/reject with notes)
4. **Bonus board + first-claim** — bonus chore kind, claim endpoint, wall + phone bonus board sections
5. **Realtime** — SSE endpoint, event broadcasting, wall pulse on done, phone live updates
6. **Polish** — streaks, weekly recap on wall Sunday night, confetti animation, dark mode toggle, sick-day/freeze-week, admin audit log, undo banner, CSV exports
7. **Notifications** — Web Push subscription flow, daily reminder, new chore, approval needed, weekly settle ready

Each phase is independently shippable; the family can use phase 1 daily while later phases land.

## 16. Open questions for implementation planning

- **Per-kid PIN** — not in MVP. Add a follow-up flag for the future.
- **Multi-parent both-approve mode** — currently any one parent can approve. Worth revisiting if it becomes a problem.
- **Discipline / "no allowance this week"** — handled informally via parent point adjustments + reason. Could be formalized later.
- **Year-end summary** — CSV ledger export covers it. A dedicated summary view could come later.

---

**Approval**: design approved by Jeffrey on 2026-05-26 via brainstorming session. Ready for implementation planning.
