CREATE TABLE people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  dob TEXT,
  role TEXT NOT NULL CHECK (role IN ('kid','parent','wall')),
  avatar_color TEXT NOT NULL DEFAULT '#6366F1',
  weekly_target_pts INTEGER NOT NULL DEFAULT 0,
  base_pay_cents INTEGER NOT NULL DEFAULT 0,
  bonus_rate_cents INTEGER NOT NULL DEFAULT 0,
  bank_cents INTEGER NOT NULL DEFAULT 0,
  streak_days INTEGER NOT NULL DEFAULT 0,
  streak_last_date TEXT,
  freeze_start TEXT,
  freeze_end TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  device_fp TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sessions_person ON sessions(person_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
