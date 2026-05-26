CREATE TABLE chores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  points INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'recurring' CHECK (kind IN ('recurring','bonus','one-off')),
  recurs TEXT NOT NULL DEFAULT 'none' CHECK (recurs IN ('none','daily','weekly','biweekly','monthly')),
  recurs_days TEXT NOT NULL DEFAULT '',
  recurs_anchor TEXT,
  due_time TEXT,
  anti_cheat TEXT NOT NULL DEFAULT 'honor' CHECK (anti_cheat IN ('honor','photo','approval')),
  late_tax_pct INTEGER,
  photo_prompt TEXT NOT NULL DEFAULT '',
  default_assignees TEXT NOT NULL DEFAULT '',
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_chores_kind ON chores(kind) WHERE deleted_at IS NULL;

CREATE TABLE assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chore_id INTEGER NOT NULL REFERENCES chores(id),
  person_id INTEGER REFERENCES people(id),
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in-progress','submitted','done','rejected','expired')),
  submitted_at TEXT,
  approved_at TEXT,
  approved_by INTEGER REFERENCES people(id),
  photo_path TEXT,
  note TEXT NOT NULL DEFAULT '',
  points_earned INTEGER NOT NULL DEFAULT 0,
  late INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_assignments_person_date ON assignments(person_id, due_date);
CREATE INDEX idx_assignments_status ON assignments(status);
CREATE UNIQUE INDEX idx_assignments_unique ON assignments(chore_id, person_id, due_date);
