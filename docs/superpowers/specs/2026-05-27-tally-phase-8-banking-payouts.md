# Tally — Phase 8 (Banking & Payouts) Design

**Date:** 2026-05-27
**Project:** Tally
**Status:** Approved, ready for implementation planning
**Builds on:** Phase 2a (weighted points + calcProjectedPay), Phase 5 (SSE wall)

---

## 1. Summary

Kids earn weekly pay based on their chore completion. Earnings automatically deposit into an in-app balance ("bank") once per week at a configurable day and time. Parents can manually adjust balances (add or deduct) with a required note. Kids see their balance and transaction history on their phone. The wall shows each kid's balance. The deposit runs lazily on the next API hit after the payout boundary, not via a background job.

## 2. Goals

1. **Running balance per kid** tracked in the app like a piggy bank account.
2. **Automatic weekly deposit** at the configured payout day/time, no parent action required.
3. **Transaction ledger** so kids (and parents) can see where money came from and went.
4. **Manual adjustments** for parent to add (birthday gift) or deduct (kid bought something) with a note.
5. **Kid visibility** into their own balance and history on their phone.
6. **Missed-week catchup** so if nobody opens the app for a while, all unpaid weeks deposit on the next visit.

## 3. Non-goals (Phase 8)

- Real money transfer (Venmo, bank API) — this is an internal tracking ledger
- Kid-initiated withdrawals or spending requests
- Savings goals or budgeting features
- Interest or compound growth
- Per-chore pay breakdown in the transaction history (just the weekly total)
- Notification when deposit happens (Phase 7 Web Push would cover this later)

## 4. Schema

### New migration: `006-transactions.sql`

```sql
CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id   INTEGER NOT NULL REFERENCES people(id),
  type        TEXT NOT NULL CHECK(type IN ('deposit','withdrawal','adjustment')),
  amount_cents INTEGER NOT NULL,
  note        TEXT,
  week_start  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_transactions_person ON transactions(person_id, created_at DESC);
CREATE INDEX idx_transactions_deposit ON transactions(person_id, type, week_start);
```

The existing `people.bank_cents` column (migration 001, default 0) serves as the denormalized running balance. Every transaction insert also updates `bank_cents` in the same SQLite transaction.

`week_start` is only populated for `type='deposit'` — it stores the Monday ISO date of the week being paid, used to prevent double-deposits. For adjustments and withdrawals, `week_start` is null.

## 5. Auto-deposit logic

### New module: `src/lib/payout.js`

Exports: `runPayoutIfDue(db)`

**Algorithm:**

1. Read settings: `payout_day` (default `'sunday'`, stored as lowercase day name) and `payout_time` (default `'20:00'`, HH:MM format).
2. Compute the most recent payout boundary: walk backward from now to find the last occurrence of `payout_day` at `payout_time`. If the current day IS payout_day and current time is past payout_time, the boundary is today. Otherwise it's the most recent past occurrence.
3. Compute `week_start` for the week that ended at this boundary. Since weeks run Mon-Sun and the payout fires on (e.g.) Sunday evening, `week_start` is the Monday 6 days before the payout boundary date.
4. Check for missed weeks: walk backward from the computed `week_start`, up to 8 weeks, checking if a deposit exists for each week. Stop at the first week that already has a deposit (or after 8 iterations).
5. For each unpaid week (oldest first):
   - For each kid (role='kid'):
     - Call `calcWeekPoints(db, kid.id, weekStartIso)` and `calcProjectedPay(kid, pts.points)`.
     - If `earnedCents > 0`: insert a transaction `{ person_id, type: 'deposit', amount_cents: earnedCents, note: 'Week of [date]', week_start: weekStartIso }` and update `people.bank_cents = bank_cents + earnedCents`.
     - If `earnedCents === 0`: insert a zero-amount deposit anyway (marks the week as processed, prevents re-checking).
   - All inserts for one week happen in a single `db.transaction()` call.

**Double-deposit prevention:** Before depositing for a week, check `SELECT 1 FROM transactions WHERE person_id = ? AND type = 'deposit' AND week_start = ?`. If a row exists (even with amount_cents = 0), skip.

**Performance:** `runPayoutIfDue` is called on every `/api/home` and `/api/wall` hit. The common case (no deposit due) is a single settings read + date comparison — no DB queries against `transactions`. The deposit check only runs when the current time is past the boundary AND `runPayoutIfDue` hasn't already run in this process lifetime for this boundary. A module-scoped `lastPayoutCheck` timestamp skips redundant checks within a 60-second window.

### Day name to day number mapping

`payout_day` is stored as a lowercase English day name: `'sunday'`, `'monday'`, etc. The module maps it to JS `getDay()` values (0=Sunday, 1=Monday, ..., 6=Saturday).

## 6. API surface

### Modified endpoints

**`GET /api/home`** — additions on `person`:
- `bank_cents` (integer) — current balance
- `transactions` (array) — last 10 transactions for this kid, newest first. Each: `{ id, type, amount_cents, note, created_at }`

Calls `runPayoutIfDue(db)` before computing the response.

**`GET /api/wall`** — additions per kid:
- `bank_cents` (integer)

Calls `runPayoutIfDue(db)` before computing the response.

**`GET /api/admin/today`** — additions per kid:
- `bank_cents` (integer)

### New route file: `src/routes/admin/bank.js`

**`GET /api/admin/bank`** — Returns all kids with balances and recent transactions.

```js
{
  kids: [
    {
      id: 1, name: 'Gabriel', avatar_color: '#22C55E',
      bank_cents: 1250,
      transactions: [ { id, type, amount_cents, note, week_start, created_at }, ... ]
    },
    ...
  ]
}
```

Returns last 20 transactions per kid.

**`POST /api/admin/bank/:personId/adjust`** — Manual adjustment.

Request body: `{ amount_cents: integer, note: string }`

- `amount_cents` is signed: positive adds, negative deducts.
- `note` is required (non-empty string).
- Inserts transaction with `type='adjustment'`, updates `bank_cents`.
- Returns `{ ok: true, bank_cents: newBalance, transaction: { ... } }`.
- Returns 400 if note is empty or amount_cents is 0.
- Calls `notifyWall()` after success (balance change shows on wall).

### Settings

`payout_day` and `payout_time` are already in `EDITABLE_KEYS`. Default values used in code:
- `payout_day`: `'sunday'`
- `payout_time`: `'20:00'`

## 7. UI surfaces

### Kid home — bank section

Below the hero card and above the "Today" chore list, a new section:

```
Bank
$12.50

May 27  Week of May 26          +$10.00
May 25  Bought a book           -$15.00
May 20  Week of May 19          +$12.50
May 18  Birthday gift           +$20.00
```

- Balance displayed large, in green if positive, red if negative (shouldn't go negative normally, but manual adjustments could cause it).
- Transaction rows: date on the left, note in the middle, amount on the right (green with + prefix for credits, red with - prefix for debits).
- Show last 10 transactions. No pagination (YAGNI).

### Admin — Bank tab

New tab in the admin tabs bar (after "Bonus board", before "People"):

Per kid card showing:
- Avatar chip + name + current balance (large)
- "Adjust" button that opens a modal with:
  - Amount input (dollar, like the existing money fields — converts to cents)
  - Note input (required, text)
  - "Add" and "Deduct" buttons (Add sends positive, Deduct sends negative)
- Last 20 transactions in a list below

### Admin — Settings tab

Two new inputs after the existing streak warning time:
- **Payout day** — dropdown: Sunday through Saturday (default Sunday)
- **Payout time** — time picker (default 20:00)

### Wall display

Per-kid meta line changes from:
```
45 pts (90%) · 3d streak
```
To:
```
$12.50 · 45 pts (90%) · 3d streak
```

Balance is prepended. Formatted as dollars. Colored green.

## 8. Tests

### New file: `tests/lib-payout.test.js`

- `runPayoutIfDue` does nothing before payout boundary
- `runPayoutIfDue` deposits for all kids when past boundary
- Deposit amount matches `calcProjectedPay` output
- Double-deposit prevention: calling twice for same week only creates one deposit per kid
- Zero-earnings kid gets a zero-amount deposit (marks week as processed)
- Missed weeks: if 2 weeks are unpaid, both get deposited on next call
- `bank_cents` on people row reflects the deposited amount

### New file: `tests/routes-admin-bank.test.js`

- `GET /api/admin/bank` returns kids with bank_cents and transactions
- `POST /api/admin/bank/:id/adjust` with positive amount adds to balance
- `POST /api/admin/bank/:id/adjust` with negative amount deducts from balance
- Adjustment requires non-empty note (400 if missing)
- Adjustment with amount_cents = 0 returns 400

### Extend: `tests/routes-home.test.js`

- `GET /api/home` returns `bank_cents` and `transactions` on person

### Extend: `tests/routes-wall.test.js`

- `GET /api/wall` returns `bank_cents` per kid

Existing tests: 144. After Phase 8: ~160.

## 9. Tech notes

- `runPayoutIfDue` is idempotent. Multiple concurrent requests hitting it simultaneously are safe because the deposit check + insert happens inside a `db.transaction()` and the `week_start` uniqueness check prevents duplicates.
- The 60-second in-memory cache on `lastPayoutCheck` is a performance optimization, not a correctness requirement. Even without it, the double-deposit prevention in the DB is the source of truth.
- `bank_cents` is denormalized for read performance (every `/api/home` and `/api/wall` hit needs it). The `transactions` table is the ledger of record. If they ever drift, a reconciliation query (`SELECT SUM(amount_cents) FROM transactions WHERE person_id = ?`) can recompute the correct balance.
- Dollar display formatting: `(cents / 100).toFixed(2)` with a `$` prefix. Negative amounts show as `-$5.00`.
- The `payout_day` setting stores the English day name rather than a number for readability in the settings table. The mapping to JS day numbers is done in `payout.js`.

## 10. Acceptance test (manual, post-deploy)

1. Set `payout_day` to today's day name and `payout_time` to a few minutes ago in admin Settings.
2. Open any kid's home page (triggers `runPayoutIfDue`).
3. Check the Bank section — a deposit should appear for this week's earnings.
4. Verify `bank_cents` matches the deposited amount.
5. Refresh — no duplicate deposit.
6. Go to admin Bank tab. See all kids, their balances, and the deposit transactions.
7. Click "Adjust" on a kid. Add $5.00 with note "Test bonus". Balance increases by $5.
8. Click "Adjust" again. Deduct $3.00 with note "Bought stickers". Balance decreases by $3.
9. Kid's phone shows both adjustments in their transaction history.
10. Wall shows updated balance per kid.

---

**Approved by user on 2026-05-27 via brainstorming session. Ready for implementation planning.**
