-- Recreate assignments table with 'excused' added to the status CHECK constraint
PRAGMA foreign_keys = OFF;

CREATE TABLE assignments_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  chore_id     INTEGER NOT NULL REFERENCES chores(id),
  person_id    INTEGER REFERENCES people(id),
  due_date     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in-progress','submitted','done','rejected','expired','excused')),
  submitted_at TEXT,
  approved_at  TEXT,
  approved_by  INTEGER REFERENCES people(id),
  photo_path   TEXT,
  note         TEXT NOT NULL DEFAULT '',
  points_earned INTEGER NOT NULL DEFAULT 0,
  late         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  stolen_from  INTEGER REFERENCES people(id)
);

INSERT INTO assignments_new SELECT * FROM assignments;

DROP TABLE assignments;
ALTER TABLE assignments_new RENAME TO assignments;

CREATE INDEX idx_assignments_person_date ON assignments(person_id, due_date);
CREATE INDEX idx_assignments_status ON assignments(status);
CREATE UNIQUE INDEX idx_assignments_unique ON assignments(chore_id, person_id, due_date);
CREATE INDEX idx_assignments_stolen_from ON assignments(stolen_from)
  WHERE stolen_from IS NOT NULL;

PRAGMA foreign_keys = ON;
