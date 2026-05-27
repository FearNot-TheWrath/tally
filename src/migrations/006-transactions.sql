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
